import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
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
    EventV2Bridge.node,
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

const succeedAs = (value: string): Work =>
  Effect.succeed({ info: { role: "assistant", id: value } as never, parts: [] })

describe("SessionRunState", () => {
  it.instance("keeps one runner per session across the finish window (two loops must be unreachable)", () =>
    Effect.gen(function* () {
      const run = yield* SessionRunState.Service
      const status = yield* SessionStatus.Service
      const sessions = yield* Session.Service
      const scope = yield* Scope.Scope
      const session = yield* sessions.create({ title: "two loops" })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let firstPredicate = true
      let executions = 0
      const shouldReArm = Effect.gen(function* () {
        if (firstPredicate) {
          firstPredicate = false
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        }
        return false
      })
      const first = yield* run
        .ensureRunning(
          session.id,
          Effect.die("no interrupt"),
          Effect.suspend(() => {
            executions++
            return succeedAs("first")
          }),
          shouldReArm,
        )
        .pipe(Effect.forkIn(scope, { startImmediately: true }))
      yield* awaitWithTimeout(Deferred.await(entered), "finish predicate not entered")

      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const waiting = yield* run
        .ensureRunning(
          session.id,
          Effect.die("no interrupt"),
          Effect.gen(function* () {
            executions++
            yield* status.set(session.id, { type: "busy" })
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(finish)
            return yield* succeedAs("waiting")
          }),
          shouldReArm,
        )
        .pipe(Effect.forkIn(scope, { startImmediately: true }))
      yield* Deferred.succeed(release, undefined)
      const firstExit = yield* awaitWithTimeout(Fiber.await(first), "first caller did not settle")
      yield* awaitWithTimeout(Deferred.await(started), "queued writer did not start")
      const third = yield* run
        .ensureRunning(
          session.id,
          Effect.die("no interrupt"),
          Effect.suspend(() => {
            executions++
            return succeedAs("unexpected")
          }),
          shouldReArm,
        )
        .pipe(Effect.forkIn(scope, { startImmediately: true }))
      const busy = (yield* status.get(session.id)).type
      yield* Deferred.succeed(finish, undefined)
      const waitingExit = yield* awaitWithTimeout(Fiber.await(waiting), "writer did not settle")
      const thirdExit = yield* awaitWithTimeout(Fiber.await(third), "joiner did not settle")
      expect(Exit.isSuccess(firstExit) && firstExit.value.info.id === "first").toBe(true)
      expect(Exit.isSuccess(waitingExit) && waitingExit.value.info.id === "waiting").toBe(true)
      expect(Exit.isSuccess(thirdExit) && thirdExit.value.info.id === "waiting").toBe(true)
      expect(busy).toBe("busy")
      expect(executions).toBe(2)
    }),
  )

  it.instance("publishes idle status before a queued writer starts the next run", () =>
    Effect.gen(function* () {
      const run = yield* SessionRunState.Service
      const status = yield* SessionStatus.Service
      const sessions = yield* Session.Service
      const events = yield* EventV2Bridge.Service
      const scope = yield* Scope.Scope
      const session = yield* sessions.create({ title: "idle ordering" })
      const idleStarted = yield* Deferred.make<void>()
      const idleRelease = yield* Deferred.make<void>()
      let hold = true
      const off = yield* events.listen((event) => {
        if (event.type !== SessionStatus.Event.Status.type) return Effect.void
        const data = event.data as { sessionID: string; status: { type: string } }
        if (!hold || data.sessionID !== session.id || data.status.type !== "idle") return Effect.void
        hold = false
        return Deferred.succeed(idleStarted, undefined).pipe(Effect.andThen(Deferred.await(idleRelease)))
      })
      yield* Effect.addFinalizer(() => off)
      const first = yield* run
        .ensureRunning(
          session.id,
          Effect.die("no interrupt"),
          status.set(session.id, { type: "busy" }).pipe(Effect.andThen(succeedAs("first"))),
        )
        .pipe(Effect.forkIn(scope, { startImmediately: true }))
      yield* awaitWithTimeout(Deferred.await(idleStarted), "idle publication not entered")
      const duringNotice = yield* run.assertNotBusy(session.id).pipe(Effect.exit)
      const workStarted = yield* Deferred.make<void>()
      const workRelease = yield* Deferred.make<void>()
      const next = yield* run
        .ensureRunning(
          session.id,
          Effect.die("no interrupt"),
          Effect.gen(function* () {
            yield* status.set(session.id, { type: "busy" })
            yield* Deferred.succeed(workStarted, undefined)
            yield* Deferred.await(workRelease)
            return yield* succeedAs("next")
          }),
        )
        .pipe(Effect.forkIn(scope, { startImmediately: true }))
      const premature = yield* Deferred.isDone(workStarted)
      yield* Deferred.succeed(idleRelease, undefined)
      yield* awaitWithTimeout(Fiber.await(first), "first caller did not settle")
      yield* awaitWithTimeout(Deferred.await(workStarted), "queued writer did not start")
      const observed = (yield* status.get(session.id)).type
      yield* Deferred.succeed(workRelease, undefined)
      yield* awaitWithTimeout(Fiber.await(next), "queued writer did not settle")
      expect(premature).toBe(false)
      expect(Exit.isFailure(duringNotice)).toBe(true)
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
