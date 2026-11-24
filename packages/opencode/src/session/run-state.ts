import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { cancelBackgroundJobsPass } from "@/tool/shell/tasks"
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
    const sessions = yield* Session.Service
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
      const expandPersistedDescendants = Effect.fnUntraced(function* () {
        // Walk persisted SQLite parent_id edges so child sessions resumed via
        // agent_send after a restart (without a process-local agent job) are
        // still reached by cancel and HTTP DELETE /session/:id.
        const visited = new Set<string>()
        for (const owner of owners) {
          if (visited.has(owner)) continue
          visited.add(owner)
          const kids = yield* sessions
            .children(owner as SessionID)
            .pipe(Effect.catchCause(() => Effect.succeed([] as SessionV1.Info[])))
          for (const child of kids) owners.add(child.id)
        }
      })
      // Step P9 (bgshell-1): the session-level cancel cascade reaches shell jobs
      // through metadata.sessionId (agent_stop / runState.cancel).
      const stopTree = Effect.fnUntraced(function* (includeRoot: boolean) {
        yield* expandPersistedDescendants()
        const jobs = yield* cancelBackgroundJobsPass(background, owners)
        // A session or descendant woken by a background shell completion notice
        // or agent_send can have a live Runner even without a running agent job.
        const runners = [...owners]
          .filter((owner) => includeRoot || owner !== sessionID)
          .map((owner) => data.runners.get(owner as SessionID))
          .filter((item): item is Runner.Runner<SessionV1.WithParts> => item !== undefined)
        const tags = yield* Effect.forEach(runners, (item) => item.cancel, { concurrency: "unbounded" })
        return { jobs, total: jobs + tags.filter((tag) => tag !== "Idle").length }
      })
      const existing = data.runners.get(sessionID)
      // Stop both the producer and jobs/descendants that could wake it. An
      // admission already committed by the producer may miss the first snapshot.
      const [stopped, firstPass] = yield* Effect.all(
        [
          existing ? existing.cancel : status.set(sessionID, { type: "idle" }).pipe(Effect.as("Idle" as const)),
          stopTree(false),
        ],
        { concurrency: "unbounded" },
      )
      // Re-check the tree until a fresh snapshot finds zero active work. Include
      // root's own Runner only when background jobs were cancelled in this tree
      // (a racing shell job's deliverAsync can re-wake root, whereas an external
      // replacement run arriving during wind-down with no background jobs must
      // remain live per agentmgmt-2-run-state).
      let includeRoot = firstPass.jobs > 0
      for (;;) {
        const pass = yield* stopTree(includeRoot)
        if (pass.total === 0) break
        if (pass.jobs > 0) includeRoot = true
      }
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

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [BackgroundJob.node, Session.node, SessionStatus.node],
})

export * as SessionRunState from "./run-state"
