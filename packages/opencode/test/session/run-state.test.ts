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

  // The idle status must be published before a queued writer (or a re-armed
  // run) starts its work, so consumers never see a running session reported
  // as idle, and never a busy session overwritten by a late idle from the
  // previous run.
  it.instance(
    "publishes idle status before a queued writer starts the next run",
    () =>
      Effect.gen(function* () {
        const run = yield* SessionRunState.Service
        const status = yield* SessionStatus.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "idle ordering" })

        const holdPredicate = yield* Deferred.make<void>()
        let holdArmed = false
        const shouldReArm = Effect.suspend(() =>
          holdArmed ? Deferred.await(holdPredicate).pipe(Effect.as(false)) : Effect.succeed(false),
        )

        const events: string[] = []
        let watching = false
        const secondWork: Work = Effect.gen(function* () {
          const current = yield* status.get(session.id)
          events.push(current.type)
          return yield* succeedAs("second")
        })
        yield* run
          .ensureRunning(
            session.id,
            Effect.die("no interrupt"),
            secondWork,
            shouldReArm,
          )
          .pipe(Effect.forkChild)

        // The runner keeps the first call's work as its re-arm target: flipping
        // `watching` now makes the restart of that same work record the status.
        holdArmed = true
        watching = true

        yield* Deferred.succeed(holdPredicate, void 0)
        // The first caller joins the re-armed run, which is the same work run
        // again: it records the status it observed and settles with "second".
        const result = yield* awaitWithTimeout(
          pollWithTimeout(
            Effect.sync(() => (events.length > 0 ? "recorded" as const : undefined)),
            "the re-armed work never ran",
            "5 seconds",
          ),
          "re-armed work never recorded",
        )
        expect(result).toBe("recorded")
        // The re-armed work observed idle: the previous run's status change had
        // already been published before this run started.
        expect(events).toEqual(["idle"])
      }),
  )
})
