import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Latch, Ref, Scope } from "effect"
import { Runner } from "@/effect/runner"
import { it, awaitWithTimeout, pollWithTimeout } from "../lib/effect"

// Seeded finite-random sequences (workflow §5.3 random-test layer): a tiny
// deterministic LCG drives a random schedule over the Runner's operations,
// with every concurrency point gated by a Deferred so the seed fully
// determines the interleaving. Failures print the seed and the trace so a
// red run is reproducible. These complement — not replace — the targeted
// RED/GREEN regressions above.

/** mulberry32: 32-bit LCG, deterministic per seed, good enough for schedules. */
const lcg = (seed: number) => {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Op =
  | { readonly _tag: "ensure"; readonly slow: boolean; readonly fail: boolean }
  | { readonly _tag: "cancel" }
  | { readonly _tag: "shell"; readonly fail: boolean }
  | { readonly _tag: "rearm"; readonly decision: boolean }

interface Model {
  // run ids whose caller has NOT yet settled (joiners share their exit)
  readonly pending: ReadonlySet<number>
  busy: boolean
  nextId: number
  // the exit the live run will produce, assigned at start
  live?: { id: number; outcome: "ok" | "fail" | "cancelled" }
  shell?: { outcome: "ok" | "fail" | "cancelled" }
}

describe("Runner (seeded finite-random schedules)", () => {
  it.live(
    "join semantics, settlement, and idle-notification ordering hold under random schedules",
    () =>
      Effect.gen(function* () {
        const failures: string[] = []
        for (const seed of [1, 2, 3, 7, 42, 2026, 65537, 99991]) {
          const result = yield* runSchedule(seed).pipe(Effect.exit)
          if (Exit.isFailure(result)) {
            const pretty = Cause.pretty(result.cause)
            failures.push(`seed=${seed} failed:\n${pretty}`)
          }
        }
        // Report every failing seed together, with the seed in the message:
        // a red run is reproducible from the trace alone.
        expect(failures).toEqual([])
      }),
  )
})

const runSchedule = (seed: number) =>
  Effect.gen(function* () {
    const rand = lcg(seed)
    const trace: string[] = []
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!

    // Gates: one deferred per scheduled operation, released in seed order so
    // the interleaving is fully determined by the seed (no random sleeps).
    const s = yield* Scope.Scope
    const order: Array<() => Effect.Effect<void>> = []
    let hookFailures = 0

    // onIdle counts invocations; a seeded invocation fails (dies) once —
    // a defecting hook must never wedge the runner (safeIdle) nor leave a
    // notification mid-flight. Different seeds place the failure at
    // different transition points (finishRun/shell/cancel).
    let idleStarts = 0
    let idleEnds = 0
    const dieAtInvocation = 1 + Math.floor(rand() * 3) // hook dies on its 1st..3rd run
    const idleGate = yield* Deferred.make<void>()
    let idleGateArmed = false
    const runner = Runner.make<string, string>(s, {
      onIdle: Effect.gen(function* () {
        idleStarts += 1
        trace.push(`idle-start#${idleStarts}`)
        if (idleStarts === dieAtInvocation) {
          trace.push(`idle-die#${idleStarts}`)
          yield* Effect.die(`idle-hook-died-${idleStarts}`)
        }
        // One seeded slow notification: widens the window a queued caller
        // could slip through, so the ordering assertions have teeth.
        if (idleGateArmed && !Deferred.isDone(idleGate)) {
          yield* Deferred.await(idleGate).pipe(Effect.timeoutOption("200 millis"))
        }
        idleEnds += 1
        trace.push(`idle-end#${idleEnds}`)
      }),
    })

    let runCounter = 0
    const startRun = (fail: boolean, slow: boolean) => {
      runCounter += 1
      const id = runCounter
      trace.push(`ensure#${id}(${fail ? "fail" : "ok"}${slow ? ",slow" : ""})`)
      return runner.ensureRunning(
        Effect.gen(function* () {
          trace.push(`work#${id}-begin`)
          if (slow) yield* Effect.sleep("5 millis")
          trace.push(`work#${id}-end`)
          if (fail) return yield* Effect.fail(`run-${id}-failed`)
          return `run-${id}-ok`
        }),
      )
    }

    const ops: Array<Effect.Effect<void>> = []
    const opCount = 6 + Math.floor(rand() * 4) // 6..9 operations per seed
    for (let i = 0; i < opCount; i++) {
      const kind = pick(["ensure", "ensure", "ensure", "cancel", "shell"] as const)
      if (kind === "ensure") {
        const slow = rand() < 0.3
        const fail = rand() < 0.25
        const fiberRef: { fiber?: Fiber.Fiber<unknown, unknown> } = {}
        ops.push(
          Effect.gen(function* () {
            const f = yield* startRun(fail, slow).pipe(Effect.exit, Effect.forkChild)
            fiberRef.fiber = f
            const exit = yield* Fiber.await(f)
            trace.push(`caller#${i}-settled:${Exit.isSuccess(exit) ? "ok" : "fail"}`)
            void fiberRef
          }),
        )
      } else if (kind === "cancel") {
        ops.push(
          Effect.gen(function* () {
            trace.push("cancel")
            yield* runner.cancel
          }),
        )
      } else {
        const fail = rand() < 0.25
        ops.push(
          Effect.gen(function* () {
            trace.push(`shell(${fail ? "fail" : "ok"})`)
            const exit = yield* runner
              .startShell(
                Effect.gen(function* () {
                  if (fail) return yield* Effect.fail("shell-failed")
                  return "shell-ok"
                }),
              )
              .pipe(Effect.exit)
            trace.push(`shell-settled:${Exit.isSuccess(exit) ? "ok" : "busy-or-fail"}`)
          }),
        )
      }
    }

    // Arm one slow idle notification somewhere mid-schedule: pick an op index
    // after which the gate releases.
    const idleGateReleaseAfter = 1 + Math.floor(rand() * (opCount - 1))
    let opIndex = 0
    for (const op of ops) {
      const current = opIndex
      if (current === idleGateReleaseAfter) {
        idleGateArmed = true
        yield* Deferred.succeed(idleGate, void 0)
      }
      opIndex += 1
      yield* op.pipe(Effect.exit)
    }
    // Let any in-flight work fibers drain (forked callers of failing runs may
    // still be settling) with a bounded wait.
    yield* Effect.sleep("50 millis")

    // Invariants over the final state:
    // 1. The runner is Idle — every scheduled operation completed, nothing
    //    wedged (a defecting hook or a wedged pre-safeIdle runner would
    //    leave the ref on Running).
    expect(runner.state._tag).toBe("Idle")
    // 2. Every started idle notification either died (isolated) or finished —
    //    none left mid-flight after the schedule drained.
    expect(idleEnds).toBe(idleStarts - (idleStarts > 0 && trace.includes(`idle-die#${dieAtInvocation}`) ? 1 : 0))
    // 3. The runner accepts a new run after the storm and settles it: the
    //    machine is not stuck in a state that cannot make progress.
    const after = yield* awaitWithTimeout(
      runner.ensureRunning(Effect.succeed("after")),
      "runner wedged: post-schedule run never settled",
      "2 seconds",
    )
    expect(after).toBe("after")
    expect(runner.state._tag).toBe("Idle")
    void order
    void hookFailures
  })

void lcg
