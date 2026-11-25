import { describe, expect } from "bun:test"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { it } from "./lib/effect"

const jobsLayer = LayerNode.compile(BackgroundJob.node)

describe("BackgroundJob", () => {
  it.live("tracks process-local work through explicit observation", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        metadata: { durable: false },
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      expect(job).toMatchObject({ type: "test", status: "running", metadata: { durable: false } })
      expect(yield* jobs.wait({ id: job.id, timeout: 0 })).toMatchObject({
        timedOut: true,
        info: { status: "running" },
      })

      yield* Deferred.succeed(latch, undefined)
      expect(yield* jobs.wait({ id: job.id })).toMatchObject({
        timedOut: false,
        info: { status: "completed", output: "done" },
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("publishes jobs before starting immediately settling work", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) => {
        const id = `job_immediate_start_${index}`
        return Effect.gen(function* () {
          const job = yield* jobs.start({
            id,
            type: "test",
            run: jobs
              .get(id)
              .pipe(
                Effect.flatMap((info) =>
                  info?.status === "running"
                    ? Effect.succeed(`done-${index}`)
                    : Effect.fail("job started before publish"),
                ),
              ),
          })

          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `done-${index}` },
          })
        })
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("increments pending work before starting immediately settling extensions", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) =>
        Effect.gen(function* () {
          const first = yield* Deferred.make<void>()
          const job = yield* jobs.start({
            type: "test",
            run: Deferred.await(first).pipe(Effect.as(`first-${index}`)),
          })

          expect(yield* jobs.extend({ id: job.id, run: Effect.succeed(`second-${index}`) })).toBe(true)
          expect((yield* jobs.get(job.id))?.status).toBe("running")

          yield* Deferred.succeed(first, undefined)
          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `second-${index}` },
          })
        }),
      )
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("interrupts live work without promising settlement after the owning process-local scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const interrupted = yield* Deferred.make<void>()
      const jobs = yield* BackgroundJob.make.pipe(Scope.provide(scope))
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      })

      yield* Scope.close(scope, Exit.void)

      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      // The abandoned in-memory registry is not a durable observation channel.
      expect((yield* jobs.get(job.id))?.status).toBe("running")
    }),
  )

  it.live("cancel records a caller-provided output snapshot", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "shell",
        run: Deferred.await(latch).pipe(Effect.as("never recorded")),
      })

      const cancelled = yield* jobs.cancel(job.id, { output: "stopped\nbuffer-tail" })
      expect(cancelled?.status).toBe("cancelled")
      expect(cancelled?.output).toBe("stopped\nbuffer-tail")
      // The snapshot survives the interruption and is the single source a
      // post-cancel read (shell_output's settled branch) consults.
      expect((yield* jobs.get(job.id))).toMatchObject({
        status: "cancelled",
        output: "stopped\nbuffer-tail",
      })
      yield* Deferred.succeed(latch, undefined)
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("cancel without an output leaves output unset", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        run: Deferred.await(latch).pipe(Effect.as("late")),
      })

      const cancelled = yield* jobs.cancel(job.id)
      expect(cancelled?.status).toBe("cancelled")
      expect(cancelled?.output).toBeUndefined()
      yield* Deferred.succeed(latch, undefined)
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("cancel closes the job scope before wait and concurrent cancel resolve, even if caller is interrupted", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      let finalized = false
      const started = yield* Deferred.make<void>()
      const closing = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        run: Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Deferred.succeed(closing, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(
                  Effect.sync(() => {
                    finalized = true
                  }),
                ),
              ),
            )
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never
          }),
        ),
      })
      yield* Deferred.await(started)

      // Waiter registered before cancel must observe finalized === true at the moment wait resolves.
      const beforeWait = yield* jobs
        .wait({ id: job.id })
        .pipe(Effect.map((result) => ({ ...result, finalized })), Effect.forkChild)

      // Start first cancel and wait until Scope.close has actually entered the finalizer.
      const firstCancel = yield* jobs.cancel(job.id).pipe(Effect.forkChild)
      yield* Deferred.await(closing)

      // Concurrent wait and second cancel entering DURING Scope.close must also wait until finalization finishes.
      const duringWait = yield* jobs
        .wait({ id: job.id })
        .pipe(Effect.map((result) => ({ ...result, finalized })), Effect.forkChild)
      const secondCancel = yield* jobs
        .cancel(job.id)
        .pipe(Effect.map((info) => ({ info, finalized })), Effect.forkChild)

      // Interrupt the first cancel caller while Scope.close is in flight: cancel must remain uninterruptible.
      const interruptFirst = yield* Fiber.interrupt(firstCancel).pipe(Effect.forkChild)
      yield* Effect.sleep("20 millis")
      expect(finalized).toBe(false)

      // Release the finalizer: every waiter and concurrent cancel must see finalized === true.
      yield* Deferred.succeed(release, undefined)
      const [w1, w2, c2] = yield* Effect.all([Fiber.join(beforeWait), Fiber.join(duringWait), Fiber.join(secondCancel)])
      yield* Fiber.await(interruptFirst)
      expect(w1.finalized).toBe(true)
      expect(w2.finalized).toBe(true)
      expect(c2.finalized).toBe(true)
      expect(w1.info?.status).toBe("cancelled")
      expect(w2.info?.status).toBe("cancelled")
      expect(c2.info?.status).toBe("cancelled")
    }).pipe(Effect.provide(jobsLayer)),
  )
})
