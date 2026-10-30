import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { disposeAllInstances } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const layer = LayerNode.compile(
  LayerNode.group([
    Config.node,
    CrossSpawnSpawner.node,
    Agent.node,
    BackgroundJob.node,
    Session.node,
    SessionProjector.node,
    SessionRunState.node,
    SessionStatus.node,
    Database.node,
  ]),
  [[InstanceStore.bootstrapNode, InstanceBootstrap.node]],
)

const it = testEffect(layer)

type Work = Effect.Effect<SessionV1.WithParts>

const succeedAs = (value: string): Work => Effect.succeed({ info: { role: "assistant", id: value } as never, parts: [] })

describe("SessionRunState", () => {
  // Reproduction of #85: a run finishing while a writer is queued publishes
  // its idle transition out-of-band — after the queued writer's run has
  // already started, on a runner the service has let go of (the map delete
  // is the first thing onIdle does). A subsequent ensureRunning call then
  // builds a second runner and one session runs two loops. Observables here:
  // the writer's run must see a live session (status busy, not the stale
  // idle), and a third writer must join the live run instead of getting a
  // second runner that runs its work concurrently.
  it.instance(
    "keeps one runner per session across the finish window (two loops must be unreachable)",
    () =>
      Effect.gen(function* () {
        const run = yield* SessionRunState.Service
        const status = yield* SessionStatus.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "two loops" })

        // Holds finishRun inside its critical section while the predicate runs,
        // widening the finish window deterministically.
        const holdPredicate = yield* Deferred.make<void>()
        let holdArmed: ((effect: Effect.Effect<boolean>) => Effect.Effect<boolean>) | undefined
        const shouldReArm = Effect.suspend(() => {
          const armed = holdArmed
          return armed
            ? armed(Deferred.await(holdPredicate).pipe(Effect.as(true)))
            : Effect.succeed(false)
        })

        let executions = 0
        const work: Work = Effect.suspend(() => {
          executions += 1
          return succeedAs("ran")
        })

        const first = yield* run.ensureRunning(session.id, Effect.die("no interrupt"), work, shouldReArm).pipe(
          Effect.forkChild,
        )
        yield* awaitWithTimeout(
          pollWithTimeout(Effect.sync(() => (executions === 1 ? (true as const) : undefined)), "first work never ran"),
          "first work never ran",
        )

        // A writer arriving while the first run is inside its finish window:
        // it grabs the runner reference, then queues on the semaphore. Its
        // run marks the session busy (as runLoop does on every step) and then
        // runs slow, so the window between the first run's idle transition
        // and the end of the writer's work stays observable.
        holdArmed = (effect) => effect
        const waitingStarted = yield* Deferred.make<void>()
        const waiting: Fiber.Fiber<SessionV1.WithParts, never> = yield* run
          .ensureRunning(session.id, Effect.die("no interrupt"), Effect.gen(function* () {
            executions += 1
            yield* Deferred.succeed(waitingStarted, void 0)
            yield* status.set(session.id, { type: "busy" })
            yield* Effect.sleep("300 millis")
            return yield* succeedAs("waiting-work")
          }))
          .pipe(Effect.forkChild)

        // Release the predicate: finishRun sees no unconsumed turn, goes idle.
        yield* Deferred.succeed(holdPredicate, void 0)

        // The first caller settled with the first run's result.
        const firstExit = yield* awaitWithTimeout(Fiber.await(first), "first caller never settled")
        expect(Exit.isSuccess(firstExit) && firstExit.value.info.id === "ran").toBe(true)
        // The queued writer started (the interleaving under test).
        yield* awaitWithTimeout(Deferred.await(waitingStarted), "queued writer never ran", "5 seconds")

        // While the writer's run is live, the status must NOT read idle: the
        // pre-fix out-of-band onIdle overwrites busy with idle while the run
        // is still going ("运行中显示 idle" of the incident; roster and
        // agent_list running-flags follow this projection).
        yield* Effect.sleep("30 millis")
        expect((yield* status.get(session.id)).type).toBe("busy")

        // A third writer arriving mid-run joins the writer's run — the same
        // runner serves the whole session, so nothing can run concurrently.
        // Its passed work is discarded by the join (the runner executes one
        // work per turn; the live run re-reads persisted messages, which is
        // how the third writer's message gets consumed — #32's design), and
        // the caller shares the run's result. A second runner (pre-fix, the
        // map had lost the live one) would run its work immediately:
        // executions would read 3 and its result would be its own.
        const third = yield* run
          .ensureRunning(session.id, Effect.die("no interrupt"), Effect.suspend(() => {
            executions += 1
            return succeedAs("third")
          }))
          .pipe(Effect.forkChild)
        const waitingExit = yield* awaitWithTimeout(Fiber.await(waiting), "queued writer never finished", "5 seconds")
        expect(Exit.isSuccess(waitingExit) && waitingExit.value.info.id === "waiting-work").toBe(true)
        const thirdExit = yield* awaitWithTimeout(Fiber.await(third), "third caller never settled", "5 seconds")
        expect(Exit.isSuccess(thirdExit) && thirdExit.value.info.id === "waiting-work").toBe(true)
        // Two executions: the third caller's work was joined away, not run
        // concurrently on a second runner.
        expect(executions).toBe(2)
      }),
  )

  // A queued writer's run may only start after the previous run's idle status
  // has been fully published: pre-fix the onIdle hook (status publish + map
  // delete) ran after the semaphore released, so a stale idle could land on a
  // session whose next run was already live. The writer runs slow and then
  // reads its own status: if the previous run's idle landed after the writer
  // started, the read sees that stale idle; post-fix the idle is inside the
  // critical section, so the writer sees its own run's busy.
  it.instance(
    "publishes idle status before a queued writer starts the next run",
    () =>
      Effect.gen(function* () {
        const run = yield* SessionRunState.Service
        const status = yield* SessionStatus.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "idle ordering" })

        // Holds the first run inside its finish critical section.
        const holdPredicate = yield* Deferred.make<void>()
        let holdArmed = false
        const shouldReArm = Effect.suspend(() =>
          holdArmed ? Deferred.await(holdPredicate).pipe(Effect.as(false)) : Effect.succeed(false),
        )

        // The first work marks busy and STAYS BUSY until we release it: an
        // instantly-settling work would flip busy→idle (its own finish
        // transition) before the poll below ever observed busy.
        const releaseFirst = yield* Deferred.make<void>()
        const firstWork: Work = Effect.gen(function* () {
          yield* status.set(session.id, { type: "busy" })
          yield* Deferred.await(releaseFirst)
          return yield* succeedAs("first")
        })
        const first = yield* run
          .ensureRunning(session.id, Effect.die("no interrupt"), firstWork, shouldReArm)
          .pipe(Effect.forkChild)
        yield* awaitWithTimeout(
          pollWithTimeout(
            Effect.map(status.get(session.id), (info) => (info.type === "busy" ? ("busy" as const) : undefined)),
            "first work never marked the session busy",
            "5 seconds",
          ),
          "first work never ran",
          "8 seconds",
        )

        // Queue a writer while the first run is inside its finish window. As
        // runLoop does (src/session/prompt.ts step 0), the writer marks the
        // session busy when its run starts, then outlives the first run's
        // transition: whatever it reads after its sleep reflects whether a
        // stale idle landed on its live run.
        holdArmed = true
        const second = yield* run
          .ensureRunning(session.id, Effect.die("no interrupt"), Effect.gen(function* () {
            yield* status.set(session.id, { type: "busy" })
            yield* Effect.sleep("200 millis")
            return yield* Effect.map(status.get(session.id), (info) => ({
              info: { role: "assistant", id: info.type } as never,
              parts: [],
            }))
          }))
          .pipe(Effect.forkChild)

        // Release the window: the first run's work unblocks, settles, and
        // goes idle inside the critical section; the queued writer starts.
        yield* Deferred.succeed(releaseFirst, void 0)
        yield* Deferred.succeed(holdPredicate, void 0)

        const firstExit = yield* awaitWithTimeout(Fiber.await(first), "first caller never settled", "5 seconds")
        expect(Exit.isSuccess(firstExit) && firstExit.value.info.id === "first").toBe(true)
        const secondExit = yield* awaitWithTimeout(Fiber.await(second), "queued writer never finished", "5 seconds")
        expect(Exit.isSuccess(secondExit)).toBe(true)

        // The writer — live and running after the transition — must not have
        // been overwritten by the previous run's idle. Pre-fix the idle ran
        // after the semaphore released and landed on the live run (stale
        // idle), so the read returned "idle"; post-fix it reads "busy".
        const observed = Exit.isSuccess(secondExit) ? secondExit.value.info.id : "failure"
        expect(observed).toBe("busy")
        expect((yield* status.get(session.id)).type).toBe("idle")
      }),
  )

  // The re-arm branch restarts the same work WITHOUT going idle: two
  // executions must occur, the original caller settles with the FIRST
  // execution's result (its Deferred completed at the re-arm point — the #32
  // contract), and no idle may be published while the restart is live.
  it.instance(
    "re-arming runs the work twice with no intermediate idle and settles the caller with the first result",
    () =>
      Effect.gen(function* () {
        const run = yield* SessionRunState.Service
        const status = yield* SessionStatus.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "rearm no idle" })

        // Predicate: true on the first finish (re-arm), false on the second
        // (settle). Reading a flag the work body itself clears makes the
        // sequence execution-order dependent (the body runs before the
        // predicate sees the value) — flip it from the PREDICATE side instead:
        // arm while the first finish is being decided, disarm once asked.
        let armed = true
        const shouldReArm = Effect.suspend(() => {
          if (!armed) return Effect.succeed(false)
          armed = false
          return Effect.succeed(true)
        })

        let executions = 0
        // First execution marks busy (as runLoop does) and settles instantly;
        // the restart must actually happen — the second execution holds the
        // session busy until released, giving the observation below a stable
        // window in which any intermediate idle would be visible.
        const releaseSecond = yield* Deferred.make<void>()
        const work: Work = Effect.suspend(() => {
          executions += 1
          if (executions === 1) {
            return Effect.gen(function* () {
              yield* status.set(session.id, { type: "busy" })
              return yield* succeedAs("first")
            })
          }
          return Effect.gen(function* () {
            yield* Deferred.await(releaseSecond)
            return yield* succeedAs("second")
          })
        })

        const fiber = yield* run
          .ensureRunning(session.id, Effect.die("no interrupt"), work, shouldReArm)
          .pipe(Effect.forkChild)

        // The caller shares the first run's exit and settles while the
        // restart is still held.
        const exit = yield* awaitWithTimeout(Fiber.await(fiber), "caller never settled", "5 seconds")
        expect(Exit.isSuccess(exit) && exit.value.info.id === "first").toBe(true)

        // The restart is live: give the second execution time to start and
        // block on its gate, then observe. A busy session here proves the
        // first finish's transition did not go idle; an idle here would mean
        // the restart published one.
        yield* awaitWithTimeout(
          pollWithTimeout(
            Effect.sync(() => (executions === 2 ? ("started" as const) : undefined)),
            "the restarted work never ran",
            "5 seconds",
          ),
          "restarted work never ran",
          "8 seconds",
        )
        yield* Effect.sleep("50 millis")
        expect((yield* status.get(session.id)).type).toBe("busy")
        // Exactly two executions: one run, one restart.
        expect(executions).toBe(2)

        // Release the restart; the second finish settles the session idle.
        yield* Deferred.succeed(releaseSecond, void 0)
        yield* awaitWithTimeout(
          pollWithTimeout(
            Effect.map(status.get(session.id), (info) => (info.type === "idle" ? ("idle" as const) : undefined)),
            "the restart never settled the session idle",
            "5 seconds",
          ),
          "restart never settled",
          "8 seconds",
        )
      }),
  )
})
