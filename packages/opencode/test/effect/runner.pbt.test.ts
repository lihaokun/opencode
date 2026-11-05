import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { Runner } from "@/effect/runner"
import { it, awaitWithTimeout, pollWithTimeout } from "../lib/effect"

// Each seed orders bounded scenarios; every overlap is held by a real Deferred.
// Assertions observe results, executed work and idle publication, not an
// implementation copy. All operation kinds occur in every seed.
function random(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let n = state
    n = Math.imul(n ^ (n >>> 15), n | 1)
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61)
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296
  }
}

function value<E>(exit: Exit.Exit<string, E>) {
  return Exit.isSuccess(exit) ? exit.value : Cause.squash(exit.cause)
}

describe("Runner (seeded concurrent scenarios)", () => {
  it.live(
    "preserves joins, cancellation, re-arm and idle ordering across seeded schedules",
    () =>
      Effect.gen(function* () {
        const failures: string[] = []
        for (const seed of [1, 2, 3, 7, 42, 2026, 65537, 99991]) {
          const result = yield* schedule(seed).pipe(Effect.scoped, Effect.timeout("5 seconds"), Effect.exit)
          if (Exit.isFailure(result)) failures.push("seed " + seed + ": " + Cause.pretty(result.cause))
        }
        expect(failures).toEqual([])
      }),
    60_000,
  )
})

const schedule = (seed: number) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const rand = random(seed)
    let rearm = false
    let idleFault = false
    let predicateFault = false
    let idleStarts = 0
    let idleEnds = 0
    let idleFailures = 0
    let idleGate: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | undefined
    const runner = Runner.make<string, string>(scope, {
      onInterrupt: Effect.succeed("cancelled"),
      shouldReArm: Effect.gen(function* () {
        if (predicateFault) {
          predicateFault = false
          return yield* Effect.die("seeded predicate defect")
        }
        const result = rearm
        rearm = false
        return result
      }),
      onIdle: Effect.gen(function* () {
        idleStarts++
        if (idleFault) {
          idleFault = false
          idleFailures++
          return yield* Effect.die("seeded idle defect")
        }
        const gate = idleGate
        if (gate) {
          yield* Deferred.succeed(gate.entered, undefined)
          yield* Deferred.await(gate.release)
        }
        idleEnds++
      }),
    })
    const fork = <E>(work: Effect.Effect<string, E>) =>
      work.pipe(Effect.exit, Effect.forkIn(scope, { startImmediately: true }))
    const kinds = ["join", "cancel", "rearm", "shell", "idle"] as const
    const plan = [
      ...kinds,
      ...Array.from({ length: 1 + Math.floor(rand() * 4) }, () => kinds[Math.floor(rand() * kinds.length)]),
    ]
      .map((kind) => ({ kind, order: rand() }))
      .sort((a, b) => a.order - b.order)

    for (const [index, item] of plan.entries()) {
      const label = seed + "/" + index + "/" + item.kind
      rearm = false
      predicateFault = false
      idleFault = item.kind !== "idle" && rand() < 0.4
      const count = 1 + Math.floor(rand() * 3)

      if (item.kind === "idle") {
        const gate = { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
        idleGate = gate
        const first = yield* fork(runner.ensureRunning(Effect.succeed("first")))
        yield* awaitWithTimeout(Deferred.await(gate.entered), label + " idle did not start")
        const transitionState = runner.state._tag
        const started = yield* Deferred.make<void>()
        const next = yield* fork(runner.ensureRunning(Deferred.succeed(started, undefined).pipe(Effect.as("next"))))
        const startedBeforeRelease = yield* Deferred.isDone(started)
        idleGate = undefined
        yield* Deferred.succeed(gate.release, undefined)
        const exits = [yield* Fiber.join(first), yield* Fiber.join(next)]
        expect(startedBeforeRelease, label).toBe(false)
        expect(transitionState, label).toBe("Running")
        expect(exits.map(value), label).toEqual(["first", "next"])
      } else if (item.kind === "rearm") {
        rearm = true
        let executions = 0
        const firstStarted = yield* Deferred.make<void>()
        const firstRelease = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const secondRelease = yield* Deferred.make<void>()
        const idleBefore = idleStarts
        const first = yield* fork(
          runner.ensureRunning(
            Effect.gen(function* () {
              executions++
              if (executions === 1) {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(firstRelease)
                return "first"
              }
              yield* Deferred.succeed(secondStarted, undefined)
              yield* Deferred.await(secondRelease)
              return "second"
            }),
          ),
        )
        yield* Deferred.await(firstStarted)
        const joiners = yield* Effect.forEach(Array.from({ length: count }), () =>
          fork(runner.ensureRunning(Effect.succeed("unexpected"))),
        )
        yield* Deferred.succeed(firstRelease, undefined)
        const exits = yield* Effect.forEach([first, ...joiners], Fiber.join)
        yield* awaitWithTimeout(Deferred.await(secondStarted), label + " did not re-arm")
        const busyDuringRearm = runner.busy
        const idleDuringRearm = idleStarts - idleBefore
        const later = yield* fork(runner.ensureRunning(Effect.succeed("unexpected")))
        yield* Deferred.succeed(secondRelease, undefined)
        const last = yield* Fiber.join(later)
        expect(exits.map(value), label).toEqual(Array.from({ length: count + 1 }, () => "first"))
        expect(value(last), label).toBe("second")
        expect(executions, label).toBe(2)
        expect(busyDuringRearm, label).toBe(true)
        expect(idleDuringRearm, label).toBe(0)
      } else if (item.kind === "shell") {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const workStarted = yield* Deferred.make<void>()
        const workRelease = yield* Deferred.make<void>()
        const shellFails = rand() < 0.3
        const cancel = rand() < 0.5
        let executions = 0
        const shell = yield* fork(
          runner.startShell(
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              if (shellFails) return yield* Effect.fail("shell failed")
              return "shell"
            }),
          ),
        )
        yield* Deferred.await(entered)
        const pending = yield* fork(
          runner.ensureRunning(
            Effect.gen(function* () {
              executions++
              yield* Deferred.succeed(workStarted, undefined)
              yield* Deferred.await(workRelease)
              return "queued"
            }),
          ),
        )
        const joiners = yield* Effect.forEach(Array.from({ length: count }), () =>
          fork(runner.ensureRunning(Effect.succeed("unexpected"))),
        )
        const queuedState = runner.state._tag
        if (cancel) {
          expect(yield* runner.cancel, label).toBe("ShellThenRun")
        } else {
          yield* Deferred.succeed(release, undefined)
          yield* awaitWithTimeout(Deferred.await(workStarted), label + " queued work did not start")
          yield* Deferred.succeed(workRelease, undefined)
        }
        const shellExit = yield* Fiber.join(shell)
        const exits = yield* Effect.forEach([pending, ...joiners], Fiber.join)
        expect(queuedState, label).toBe("ShellThenRun")
        expect(value(shellExit), label).toBe(cancel ? "cancelled" : shellFails ? "shell failed" : "shell")
        expect(exits.map(value), label).toEqual(
          Array.from({ length: count + 1 }, () => (cancel ? "cancelled" : "queued")),
        )
        expect(executions, label).toBe(cancel ? 0 : 1)
      } else {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const fail = item.kind === "join" && rand() < 0.3
        predicateFault = item.kind === "join" && !fail
        let executions = 0
        const first = yield* fork(
          runner.ensureRunning(
            Effect.gen(function* () {
              executions++
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              if (fail) return yield* Effect.fail("work failed")
              return "done"
            }),
          ),
        )
        yield* Deferred.await(entered)
        const joiners = yield* Effect.forEach(Array.from({ length: count }), () =>
          fork(
            runner.ensureRunning(
              Effect.sync(() => {
                executions++
                return "unexpected"
              }),
            ),
          ),
        )
        if (item.kind === "cancel") {
          expect(yield* runner.cancel, label).toBe("Running")
        } else {
          yield* Deferred.succeed(release, undefined)
        }
        const exits = yield* Effect.forEach([first, ...joiners], Fiber.join)
        const expected = item.kind === "cancel" ? "cancelled" : fail ? "work failed" : "done"
        expect(exits.map(value), label).toEqual(Array.from({ length: count + 1 }, () => expected))
        expect(executions, label).toBe(1)
      }
      yield* pollWithTimeout(
        Effect.sync(() => (runner.state._tag === "Idle" ? true : undefined)),
        label + " did not settle",
      )
      expect(idleEnds + idleFailures, label).toBe(idleStarts)
    }
    expect(yield* runner.ensureRunning(Effect.succeed("after")), "seed " + seed).toBe("after")
    expect(runner.state._tag).toBe("Idle")
  })
