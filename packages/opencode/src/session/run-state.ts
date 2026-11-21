import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { cancelSnapshot } from "@/tool/shell/tasks"
import { Effect, Latch, Layer, Scope, Context } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  /** Resolves with what the cancel found, as Runner.cancel does; `Idle` when there was no runner. */
  readonly cancel: (sessionID: SessionID) => Effect.Effect<Runner.StateTag>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    shouldReArm?: Effect.Effect<boolean>,
  ) => Effect.Effect<SessionV1.WithParts>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    ready?: Latch.Latch,
    shouldReArm?: Effect.Effect<boolean>,
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, Runner.Runner<SessionV1.WithParts>>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
          }),
        )
        return { runners, scope }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      shouldReArm?: Effect.Effect<boolean>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      // One Runner per session for the lifetime of the instance: it is never
      // removed from the map. Deleting it on idle opened a race (#85) — a
      // writer that grabbed the reference before the delete then started a
      // run on a runner the map no longer knew about, and the next writer
      // built a second runner, leaving one session with two loops. Reusing a
      // stale runner is safe because every hook below is parameterized by
      // sessionID and re-reads persisted state when it executes; a hook that
      // captures per-run state at creation time would break that invariant.
      const next = Runner.make<SessionV1.WithParts>(data.scope, {
        onIdle: status.set(sessionID, { type: "idle" }),
        onBusy: status.set(sessionID, { type: "busy" }),
        onInterrupt,
        shouldReArm,
      })
      data.runners.set(sessionID, next)
      return next
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.busy) yield* busyError(sessionID)
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      const owners = new Set<string>([sessionID])
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      const stopJobs = cancelBackgroundJobs(background, owners)
      // Stop both the producer and jobs that could wake it. An admission
      // already committed by the producer may miss the first job snapshot.
      const [stopped] = yield* Effect.all(
        [
          existing ? existing.cancel : status.set(sessionID, { type: "idle" }).pipe(Effect.as("Idle" as const)),
          stopJobs,
        ],
        { concurrency: "unbounded" },
      )
      // The producer has quiesced. Follow newly discovered descendant owners
      // and take a fresh snapshot after each batch of cancellation finalizers.
      yield* stopJobs.pipe(Effect.repeat({ while: (count) => count > 0 }))
      return stopped
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      shouldReArm?: Effect.Effect<boolean>,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt, shouldReArm)).ensureRunning(work)
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      ready?: Latch.Latch,
      shouldReArm?: Effect.Effect<boolean>,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt, shouldReArm))
        .startShell(work, ready)
        .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
    })

    return Service.of({ assertNotBusy, cancel, ensureRunning, startShell })
  }),
)

// Step P9 (bgshell-1): the session-level cancel cascade reaches shell jobs
// through metadata.sessionId (agent_stop / runState.cancel).
const cancelBackgroundJobs = Effect.fn("SessionRunState.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  owners: Set<string>,
) {
  const all = yield* background.list()
  const children = new Map<string, string[]>()
  for (const job of all) {
    const parent = job.metadata?.parentSessionId
    if (job.type !== "agent" || typeof parent !== "string") continue
    const child = typeof job.metadata?.sessionId === "string" ? job.metadata.sessionId : job.id
    const siblings = children.get(parent)
    if (!siblings) {
      children.set(parent, [child])
      continue
    }
    siblings.push(child)
  }
  // A delegation can have finished while its shell is live. Set iteration
  // visits newly added descendants and terminates even if an edge repeats.
  for (const owner of owners) {
    for (const child of children.get(owner) ?? []) owners.add(child)
  }
  const jobs = all.filter((job) => {
    if (job.status !== "running") return false
    if (owners.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && owners.has(job.metadata.sessionId)) return true
    return typeof job.metadata?.parentSessionId === "string" && owners.has(job.metadata.parentSessionId)
  })
  yield* Effect.forEach(
    jobs,
    (job) => {
      owners.add(job.id)
      if (typeof job.metadata?.sessionId === "string") owners.add(job.metadata.sessionId)
      // The interrupted shell cannot settle its own output.
      return background.cancel(job.id, { output: cancelSnapshot(job.id) })
    },
    { concurrency: "unbounded", discard: true },
  )
  return jobs.length
})

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [BackgroundJob.node, SessionStatus.node] })

export * as SessionRunState from "./run-state"
