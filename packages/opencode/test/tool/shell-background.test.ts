import { expect } from "bun:test"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { FastCheck, TestClock } from "effect/testing"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "../../src/background/job"
import { Plugin } from "../../src/plugin"
import { Truncate } from "../../src/tool/truncate"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { ShellOutputTool, ShellKillTool, ShellTool } from "../../src/tool/shell"
import { MessageID, SessionID } from "../../src/session/schema"
import type { Tool } from "../../src/tool/tool"
import type { AgentManagement } from "../../src/agent-management/schema"
import { TestInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const shellLayer = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      FSUtil.node,
      Plugin.node,
      Truncate.node,
      Config.node,
      Agent.node,
      RuntimeFlags.node,
      BackgroundJob.node,
      SessionStatus.node,
      SessionRunState.node,
    ]),
  ),
  testInstanceStoreLayer,
)
const it = testEffect(shellLayer)

const sessionID = SessionID.make("ses_bg_shell")
const otherSessionID = SessionID.make("ses_bg_shell_stranger")

const makeCtx = (opts?: {
  session?: SessionID
  promptOps?: AgentManagement.AgentPromptOps
}): Tool.Context =>
  ({
    sessionID: opts?.session ?? sessionID,
    messageID: MessageID.make("msg_bg_shell"),
    callID: "call_bg",
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
    extra: opts ? { promptOps: opts.promptOps } : undefined,
  }) as unknown as Tool.Context

const initTools = Effect.gen(function* () {
  const shell = yield* (yield* ShellTool).init()
  const output = yield* (yield* ShellOutputTool).init()
  const kill = yield* (yield* ShellKillTool).init()
  return { shell, output, kill }
})

function startedTaskID(result: { metadata: object }) {
  if ("task_id" in result.metadata && typeof result.metadata.task_id === "string") return result.metadata.task_id
  throw new Error("background start did not return a task_id")
}

const waitUntilOutput = (
  output: { execute: (args: { task_id: string }, ctx: Tool.Context) => Effect.Effect<{ output: string }> },
  ctx: Tool.Context,
  taskId: string,
  needle: string,
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const result = yield* output.execute({ task_id: taskId }, ctx)
      if (result.output.split("\n").slice(2).includes(needle)) return
      yield* Effect.sleep(50)
    }
    throw new Error(`timed out waiting for output containing: ${needle}`)
  })

it.instance("background start returns a task id immediately", () =>
  Effect.gen(function* () {
    const tools = yield* initTools
    const startedAt = Date.now()
    const result = yield* tools.shell.execute(
      { command: `bun -e "await Bun.sleep(2_000)"`, run_in_background: true },
      makeCtx(),
    )
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    const taskId = /shell_[^\s\]]+/.exec(result.output)![0]
    const bg = yield* BackgroundJob.Service
    const all = yield* bg.list()
    const job = yield* bg.get(taskId)
    expect(job?.status).toBe("running")
    expect(result.metadata.exit).toBe(null)
    yield* tools.kill.execute({ task_id: taskId }, makeCtx())
  }),
)

it.instance("shell_output reads interim output and final status", () =>
  Effect.gen(function* () {
    const tools = yield* initTools
    const started = yield* tools.shell.execute(
      { command: `bun -e "console.log('bg-marker'); await Bun.sleep(3_000)"`, run_in_background: true },
      makeCtx(),
    )
    const taskId = /shell_[^\s\]]+/.exec(started.output)![0]

    yield* waitUntilOutput(tools.output, makeCtx(), taskId, "bg-marker")
    const interim = (yield* tools.output.execute({ task_id: taskId }, makeCtx())) as { output: string }
    expect(interim.output).toContain("status: running")

    yield* tools.kill.execute({ task_id: taskId }, makeCtx())
    // R6: the kill path records a `stopped` snapshot with the buffer, so the
    // post-kill read shows the real stop (not the bare registry-less
    // "cancelled") plus whatever the task printed before the kill.
    const final = (yield* tools.output.execute({ task_id: taskId }, makeCtx())) as { output: string }
    expect(final.output).toContain("status: stopped")
    expect(final.output.split("\n").slice(2)).toContain("bg-marker")
  }),
)

it.instance("completion delivers a notification message with the exit code", () =>
  Effect.gen(function* () {
    const delivered: unknown[] = []
    const promptOps = {
      deliverAsync: (input: unknown) =>
        Effect.sync(() => {
          delivered.push(input)
        }),
    } as unknown as AgentManagement.AgentPromptOps
    const tools = yield* initTools
    const result = yield* tools.shell.execute(
      { command: `bun -e "process.exit(7)"`, run_in_background: true },
      makeCtx({ promptOps }),
    )
    const taskId = /shell_[^\s\]]+/.exec(result.output)![0]

    const deadline = Date.now() + 10_000
    while (delivered.length === 0 && Date.now() < deadline) yield* Effect.sleep(50)
    expect(delivered.length).toBeGreaterThan(0)
    const wire = JSON.stringify(delivered[0])
    expect(wire).toContain("[shell task finished]")
    expect(wire).toContain("exit 7")
    expect(wire).toContain(taskId)
  }),
)

it.instance("shell_kill stops a running background task", () =>
  Effect.gen(function* () {
    const tools = yield* initTools
    const started = yield* tools.shell.execute(
      { command: `bun -e "await Bun.sleep(30_000)"`, run_in_background: true },
      makeCtx(),
    )
    const taskId = /shell_[^\s\]]+/.exec(started.output)![0]

    const stopped = yield* tools.kill.execute({ task_id: taskId }, makeCtx())
    expect(stopped.output).toContain("stopped (cancelled)")
  }),
)

// The job carries the owning session in its metadata, so the session-run
// cancel cascade (agent_stop, interrupt) reaches the process. The stopped
// session must also stay stopped: no completion delivery, no wake.
it.instance("session cancel stops the background process and suppresses the completion notice", () =>
  Effect.gen(function* () {
    const delivered: unknown[] = []
    const promptOps = {
      deliverAsync: (input: unknown) =>
        Effect.sync(() => {
          delivered.push(input)
        }),
    } as unknown as AgentManagement.AgentPromptOps
    const tools = yield* initTools
    const runState = yield* SessionRunState.Service
    const started = yield* tools.shell.execute(
      { command: `bun -e "console.log('cancel-marker'); await Bun.sleep(30_000)"`, run_in_background: true },
      makeCtx({ promptOps }),
    )
    const taskId = /shell_[^\s\]]+/.exec(started.output)![0]

    const bg = yield* BackgroundJob.Service
    const before = yield* bg.get(taskId)
    expect(before?.metadata?.sessionId).toBe(sessionID)

    yield* waitUntilOutput(tools.output, makeCtx(), taskId, "cancel-marker")
    yield* runState.cancel(sessionID)
    const job = yield* bg.get(taskId)
    expect(job?.status).toBe("cancelled")

    // A cancelled job's run never reaches the delivery step; give the fiber a
    // moment to prove the absence rather than racing it.
    yield* Effect.sleep(500)
    expect(delivered).toHaveLength(0)
    const final = (yield* tools.output.execute({ task_id: taskId }, makeCtx())) as { output: string }
    // R6 parity: the cascade now carries the same snapshot the direct kill
    // path records — the settled read reports "stopped" plus the tail, not a
    // bare "cancelled" with the buffer gone.
    expect(final.output).toContain("status: stopped")
    expect(final.output.split("\n").slice(2)).toContain("cancel-marker")
  }),
)

it.instance("background.start records the owning session id in job metadata", () =>
  Effect.gen(function* () {
    const tools = yield* initTools
    const started = yield* tools.shell.execute(
      { command: `bun -e "await Bun.sleep(1_000)"`, run_in_background: true },
      makeCtx(),
    )
    const taskId = /shell_[^\s\]]+/.exec(started.output)![0]
    const bg = yield* BackgroundJob.Service
    const job = yield* bg.get(taskId)
    expect(job?.metadata?.sessionId).toBe(sessionID)
    expect(job?.type).toBe("shell")
    yield* tools.kill.execute({ task_id: taskId }, makeCtx())
  }),
)

// The buffer is a bounded tail, and the registry entry is dropped once the run
// settles: a long-lived process must not retain every byte it printed, and a
// finished task must not linger in the map for the life of the process.
it.instance("buffer is capped and the task entry is cleaned up after the run settles", () =>
  Effect.gen(function* () {
    const tools = yield* initTools
    const line = "x".repeat(900) + "\n"
    const started = yield* tools.shell.execute(
      {
        command: `bun -e "for (let i = 0; i < 400; i++) console.log('${'x'.repeat(900)}') "`,
        run_in_background: true,
      },
      makeCtx(),
    )
    const taskId = /shell_[^\s\]]+/.exec(started.output)![0]

    // ~360 KB printed, cap is 200 K chars: wait out the run.
    const bg = yield* BackgroundJob.Service
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const job = yield* bg.get(taskId)
      if (job && job.status !== "running") break
      yield* Effect.sleep(50)
    }
    const job = yield* bg.get(taskId)
    expect(job?.status).toBe("completed")

    const final = (yield* tools.output.execute({ task_id: taskId }, makeCtx())) as { output: string }
    expect(final.output).toContain("status: exit 0")
    expect(job?.output?.slice("exit 0\n".length)).toBe(line.repeat(400).slice(-200_000))

    // Settled runs remove their registry entry; shell_output then falls back
    // to the BackgroundJob snapshot for status and reports the missing tail.
    const output = yield* tools.output.execute({ task_id: taskId }, makeCtx())
    expect(output.output).toContain(`[shell task ${taskId}]`)
  }),
)

// The post-settle fallback reports the REAL exit code: the settle output leads
// with the status line precisely so the fallback never has to guess. A non-zero
// exit displayed as "exit 0" would make the model read a failure as success.
it.instance("shell_output after settle reports the real non-zero exit code", () =>
  Effect.gen(function* () {
    const tools = yield* initTools
    const started = yield* tools.shell.execute(
      { command: `bun -e "console.log('seven'); process.exit(7)"`, run_in_background: true },
      makeCtx(),
    )
    const taskId = /shell_[^\s\]]+/.exec(started.output)![0]
    const bg = yield* BackgroundJob.Service
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const job = yield* bg.get(taskId)
      if (job && job.status !== "running") break
      yield* Effect.sleep(50)
    }

    const final = (yield* tools.output.execute({ task_id: taskId }, makeCtx())) as { output: string }
    expect(final.output).toContain("status: exit 7")
    expect(final.output).not.toContain("exit 0")
    expect(final.output).toContain("seven")
  }),
)

// Killing cancels the run fiber mid-flight, so the entry cleanup must survive
// the interruption: one cancelled task, one removed entry — no leak.
it.instance("shell_kill cleans the registry entry; killing a settled task is idempotent", () =>
  Effect.gen(function* () {
    const tools = yield* initTools
    const started = yield* tools.shell.execute(
      { command: `bun -e "console.log('kill-marker'); await Bun.sleep(30_000)"`, run_in_background: true },
      makeCtx(),
    )
    const taskId = /shell_[^\s\]]+/.exec(started.output)![0]
    yield* waitUntilOutput(tools.output, makeCtx(), taskId, "kill-marker")

    yield* tools.kill.execute({ task_id: taskId }, makeCtx())
    // Settled (as cancelled) — the entry is gone even though the run was
    // interrupted before reaching its own cleanup.
    const bg = yield* BackgroundJob.Service
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const job = yield* bg.get(taskId)
      if (job && job.status !== "running") break
      yield* Effect.sleep(50)
    }
    expect((yield* bg.get(taskId))?.status).toBe("cancelled")

    // Idempotent kill: a settled task answers from its snapshot instead of
    // erroring with "unknown task".
    const again = yield* tools.kill.execute({ task_id: taskId }, makeCtx())
    expect(again.output).toContain("already settled (cancelled)")
  }),
)

// The start result carries the task handle in metadata for programmatic
// consumers (detailed-design §5.1): the text is for the model, the metadata
// is the interface.
it.instance("start result metadata carries task_id and running status", () =>
  Effect.gen(function* () {
    const tools = yield* initTools
    const started = yield* tools.shell.execute(
      { command: `bun -e "await Bun.sleep(500)"`, run_in_background: true },
      makeCtx(),
    )
    const taskId = /shell_[^\s\]]+/.exec(started.output)![0]
    expect(started.metadata).toMatchObject({ task_id: taskId, status: "running" })
    expect(started.output).toContain("a restart loses them")
    const bg = yield* BackgroundJob.Service
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const job = yield* bg.get(taskId)
      if (job && job.status !== "running") break
      yield* Effect.sleep(50)
    }
  }),
)

it.instance("shell_output reports unknown tasks diagnosably", () =>
  Effect.gen(function* () {
    const tools = yield* initTools
    const exit = yield* Effect.exit(tools.output.execute({ task_id: "shell_missing" }, makeCtx()))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(String(Cause.squash(exit.cause))).toContain("unknown task: shell_missing")
    }
  }),
)

// R1: ownership is checked on the settled path too. Session A starts a task
// and lets it finish; session B (a different sessionID, same instance) reads
// the same task_id — it must be refused on every terminal shape, not just
// while the entry is live.
it.instance("shell_output refuses cross-session reads of a settled task", () =>
  Effect.gen(function* () {
    const tools = yield* initTools
    const owner = makeCtx()
    const started = yield* tools.shell.execute(
      { command: `bun -e "console.log('owner-only-marker')"`, run_in_background: true },
      owner,
    )
    const taskId = /shell_[^\s\]]+/.exec(started.output)![0]
    const bg = yield* BackgroundJob.Service
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const job = yield* bg.get(taskId)
      if (job && job.status !== "running") break
      yield* Effect.sleep(50)
    }

    // Owner still reads fine after settle.
    const mine = yield* tools.output.execute({ task_id: taskId }, owner)
    expect(mine.output).toContain("owner-only-marker")

    // The stranger is refused (completed shape).
    const stranger = makeCtx({ session: otherSessionID })
    const refused = yield* Effect.exit(tools.output.execute({ task_id: taskId }, stranger))
    expect(Exit.isFailure(refused)).toBe(true)
    if (Exit.isFailure(refused)) {
      expect(String(Cause.squash(refused.cause))).toContain(`unknown task: ${taskId}`)
    }

    // And the kill tool's settled branch refuses the stranger the same way.
    const refusedKill = yield* Effect.exit(tools.kill.execute({ task_id: taskId }, stranger))
    expect(Exit.isFailure(refusedKill)).toBe(true)
  }),
)

// R6: cancelling must not lose the tail. The kill response carries it, but a
// later shell_output must still read it from the cancelled job's snapshot —
// the interrupted fiber never settles, so the kill path records the buffer.
it.instance("shell_output keeps the output tail after a kill", () =>
  Effect.gen(function* () {
    const tools = yield* initTools
    const started = yield* tools.shell.execute(
      { command: `bun -e "console.log('tail-keeper'); await Bun.sleep(30_000)"`, run_in_background: true },
      makeCtx(),
    )
    const taskId = /shell_[^\s\]]+/.exec(started.output)![0]
    yield* waitUntilOutput(tools.output, makeCtx(), taskId, "tail-keeper")

    yield* tools.kill.execute({ task_id: taskId }, makeCtx())
    const bg = yield* BackgroundJob.Service
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const job = yield* bg.get(taskId)
      if (job && job.status !== "running") break
      yield* Effect.sleep(50)
    }

    const after = (yield* tools.output.execute({ task_id: taskId }, makeCtx())) as { output: string }
    expect(after.output.split("\n").slice(2)).toContain("tail-keeper")
    expect(after.output).toContain("status: stopped")
    // The old copy pointed at a completion message that a cancel never sends.
    expect(after.output).not.toContain("see the completion message")
  }),
)

// R5: the default (no task_id) lookup must see settled tasks — the live
// registry is empty after settle, but the session's most recent shell job is
// still the right default target.
it.instance("shell_output without task_id resolves the most recent settled task", () =>
  Effect.gen(function* () {
    const tools = yield* initTools
    const ctx = makeCtx()
    const started = yield* tools.shell.execute(
      { command: `bun -e "console.log('default-target-marker')"`, run_in_background: true },
      ctx,
    )
    const taskId = /shell_[^\s\]]+/.exec(started.output)![0]
    const bg = yield* BackgroundJob.Service
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const job = yield* bg.get(taskId)
      if (job && job.status !== "running") break
      yield* Effect.sleep(50)
    }

    const byDefault = (yield* tools.output.execute({}, ctx)) as { output: string }
    expect(byDefault.output).toContain(taskId)
    expect(byDefault.output).toContain("default-target-marker")

    // The default never crosses sessions either.
    const stranger = makeCtx({ session: otherSessionID })
    const refused = yield* Effect.exit(tools.output.execute({}, stranger))
    expect(Exit.isFailure(refused)).toBe(true)
  }),
)
// Generate output independently of its representation in the command title.
// The marker only appears as a complete line after a child actually writes it.
it.instance("tail_lines counts a final newline as the end of the last line", () =>
  Effect.gen(function* () {
    const tools = yield* initTools
    const jobs = yield* BackgroundJob.Service
    const ctx = makeCtx()
    const started = yield* tools.shell.execute(
      {
        command: `bun -e "console.log(22); console.log(33)"`,
        run_in_background: true,
      },
      ctx,
    )
    const id = startedTaskID(started)
    yield* jobs.wait({ id })
    const result = yield* tools.output.execute({ task_id: id, tail_lines: 1 }, ctx)
    expect(result.output.split("\n").slice(2).filter(Boolean)).toEqual(["33"])
  }),
)

it.instance("a failed shell spawn remains diagnosable after settlement", () =>
  Effect.gen(function* () {
    const tools = yield* initTools
    const jobs = yield* BackgroundJob.Service
    const ctx = makeCtx()
    const started = yield* tools.shell.execute(
      {
        command: "echo hello",
        workdir: "does-not-exist",
        run_in_background: true,
      },
      ctx,
    )
    const id = startedTaskID(started)
    const { info } = yield* jobs.wait({ id })
    expect(info?.status).toBe("error")
    const result = yield* tools.output.execute({ task_id: id }, ctx)
    expect(result.output).toContain("does-not-exist")
  }),
)

it.instance("failed completion delivery preserves the process exit and captured output", () =>
  Effect.gen(function* () {
    const tools = yield* initTools
    const jobs = yield* BackgroundJob.Service
    let attempts = 0
    const ctx = makeCtx({
      promptOps: {
        deliverAsync: () =>
          Effect.sync(() => {
            attempts++
            throw new Error("target unavailable during delivery")
          }),
      } as unknown as AgentManagement.AgentPromptOps,
    })
    const started = yield* tools.shell.execute(
      {
        command: `bun -e "console.log(42); process.exit(7)"`,
        run_in_background: true,
      },
      ctx,
    )
    const id = startedTaskID(started)
    const { info } = yield* jobs.wait({ id })
    expect(attempts).toBe(1)
    expect(info?.status).toBe("completed")
    const result = yield* tools.output.execute({ task_id: id }, ctx)
    expect(result.output.split("\n")).toEqual(expect.arrayContaining(["status: exit 7", "42"]))
  }),
)

it.instance("the most recently admitted shell wins a same-millisecond tie", () =>
  Effect.gen(function* () {
    const tools = yield* initTools
    const jobs = yield* BackgroundJob.Service
    const starts = yield* Effect.forEach(["shell_first", "shell_second"], (id) =>
      jobs.start({ id, type: "shell", metadata: { sessionId: sessionID }, run: Effect.succeed("exit 0\n") }),
    ).pipe(Effect.provide(TestClock.layer()))
    expect(starts[0]!.started_at).toBe(starts[1]!.started_at)
    const result = yield* tools.output.execute({}, makeCtx())
    expect(result.metadata.task_id).toBe("shell_second")
  }),
)

it.instance("large background reads and stops keep the latest output in memory", () =>
  Effect.gen(function* () {
    const tools = yield* initTools
    const fs = yield* FSUtil.Service
    yield* fs.ensureDir(Truncate.DIR)
    const before = yield* fs.readDirectory(Truncate.DIR)
    const ctx = makeCtx()
    const started = yield* tools.shell.execute(
      {
        command: `bun -e "console.log('q'.repeat(120000)); console.log(12345); await Bun.sleep(20000)"`,
        run_in_background: true,
      },
      ctx,
    )
    const id = startedTaskID(started)
    // Probe the small line window first; default windows would already trigger
    // the very disk write that this check is intended to detect.
    yield* pollWithTimeout(
      tools.output
        .execute({ task_id: id, tail_lines: 2 }, ctx)
        .pipe(Effect.map((r) => r.output.split("\n").includes("12345") || undefined)),
      "the final output marker never arrived",
    )
    const live = yield* tools.output.execute({ task_id: id }, ctx)
    const stopped = yield* tools.kill.execute({ task_id: id }, ctx)
    const terminal = yield* tools.output.execute({ task_id: id }, ctx)
    const repeated = yield* tools.kill.execute({ task_id: id }, ctx)
    expect((yield* fs.readDirectory(Truncate.DIR)).toSorted()).toEqual(before.toSorted())
    for (const result of [live, stopped, terminal, repeated]) {
      expect(result.metadata).not.toHaveProperty("outputPath")
      expect(result.output.split("\n")).toContain("12345")
    }
  }),
)

const unix = process.platform === "win32" ? it.instance.skip : it.instance
unix(
  "shell_kill terminates a TERM-resistant process before its natural exit",
  () =>
    Effect.gen(function* () {
      const tools = yield* initTools
      const ctx = makeCtx()
      const { directory } = yield* TestInstance
      // The sentinel is written only if the process runs to its natural exit.
      // The finite timer also cleans up an unmodified implementation after the red test.
      const started = yield* tools.shell.execute(
        {
          command: `exec bun -e "process.on('SIGTERM', () => {}); console.log(4321); await Bun.sleep(8000); await Bun.write('natural-exit', 'finished')"`,
          run_in_background: true,
        },
        ctx,
      )
      const id = startedTaskID(started)
      yield* waitUntilOutput(tools.output, ctx, id, "4321")
      const result = yield* tools.kill.execute({ task_id: id }, ctx)
      expect(result.metadata.status).toBe("cancelled")
      expect(yield* Effect.promise(() => Bun.file(path.join(directory, "natural-exit")).exists())).toBe(false)
    }),
  20_000,
)

unix(
  "shell_kill also stops TERM-resistant workers that redirect output",
  () =>
    Effect.gen(function* () {
      const tools = yield* initTools
      const ctx = makeCtx()
      const { directory } = yield* TestInstance
      // A trailing command keeps the shell as process group leader. Redirected
      // stdio allows the shell's close event while its worker is still alive.
      const started = yield* tools.shell.execute(
        {
          command: `bun -e "process.on('SIGTERM', () => {}); await Bun.write('worker-ready', 'yes'); await Bun.sleep(6000); await Bun.write('survived-stop', 'yes')" > worker.log 2>&1; true`,
          run_in_background: true,
        },
        ctx,
      )
      const file = (name: string) => Effect.promise(() => Bun.file(path.join(directory, name)).exists())
      yield* pollWithTimeout(
        file("worker-ready").pipe(Effect.map((ready) => ready || undefined)),
        "worker never started",
      )
      const until = Date.now() + 6500
      yield* tools.kill.execute({ task_id: startedTaskID(started) }, ctx)
      // Wait through the worker's finite lifetime on both a green and a red
      // implementation. An orphan cannot write after the test's fixture closes.
      yield* Effect.sleep(Math.max(0, until - Date.now()))
      expect(yield* file("survived-stop")).toBe(false)
    }),
  15_000,
)

it.instance(
  "generated shell lifecycles retain the owner's output and terminal result",
  () =>
    Effect.gen(function* () {
      const tools = yield* initTools
      const jobs = yield* BackgroundJob.Service
      const state = yield* SessionRunState.Service
      const run = Effect.runPromiseWith(yield* Effect.context())
      const sequences = FastCheck.record({
        finish: FastCheck.constantFrom("natural", "kill", "session-cancel"),
        value: FastCheck.nat(99),
        live: FastCheck.array(FastCheck.constantFrom("owner-read", "stranger-read", "stranger-kill"), { maxLength: 5 }),
        terminal: FastCheck.array(
          FastCheck.constantFrom("owner-read", "owner-kill", "stranger-read", "stranger-kill"),
          { maxLength: 5 },
        ),
      })
      yield* Effect.promise(() =>
        FastCheck.assert(
          FastCheck.asyncProperty(sequences, (actions) =>
            run(
              Effect.gen(function* () {
                let notices = 0
                const ctx = makeCtx({
                  promptOps: {
                    deliverAsync: () =>
                      Effect.sync(() => {
                        notices++
                      }),
                  } as unknown as AgentManagement.AgentPromptOps,
                })
                const stranger = makeCtx({ session: otherSessionID })
                const delay = actions.finish === "natural" ? "" : "await Bun.sleep(20000);"
                const started = yield* tools.shell.execute(
                  {
                    command: `bun -e "console.log(1000 + ${actions.value}); ${delay} process.exit(7)"`,
                    run_in_background: true,
                  },
                  ctx,
                )
                const id = startedTaskID(started)
                const marker = String(1000 + actions.value)
                yield* waitUntilOutput(tools.output, ctx, id, marker)
                const check = (operation: string) =>
                  Effect.gen(function* () {
                    const owner = operation.startsWith("owner")
                    const result = yield* Effect.exit(
                      (operation.endsWith("read") ? tools.output : tools.kill).execute(
                        { task_id: id },
                        owner ? ctx : stranger,
                      ),
                    )
                    if (!owner) {
                      expect(Exit.isFailure(result)).toBe(true)
                      if (Exit.isFailure(result)) expect(String(Cause.squash(result.cause))).toContain("unknown task")
                      return
                    }
                    if (Exit.isFailure(result)) throw new Error(Cause.pretty(result.cause))
                    if (operation === "owner-read") expect(result.value.output.split("\n")).toContain(marker)
                  })
                yield* Effect.forEach(actions.live, check)
                if (actions.finish === "kill") yield* tools.kill.execute({ task_id: id }, ctx)
                if (actions.finish === "session-cancel") yield* state.cancel(ctx.sessionID)
                const { info } = yield* jobs.wait({ id })
                yield* Effect.forEach(actions.terminal, check)
                const result = yield* tools.output.execute({ task_id: id }, ctx)
                expect(result.output.split("\n")).toEqual(
                  expect.arrayContaining([actions.finish === "natural" ? "status: exit 7" : "status: stopped", marker]),
                )
                expect(info?.status).toBe(actions.finish === "natural" ? "completed" : "cancelled")
                expect(yield* jobs.get(id)).toEqual(info)
                expect(notices).toBe(actions.finish === "natural" ? 1 : 0)
              }),
            ),
          ),
          { seed: 60004, numRuns: 30 },
        ),
      )
    }),
  30_000,
)

it.instance(
  "shell output respects the configured byte budget and preserves UTF-8",
  () =>
    Effect.gen(function* () {
      const tools = yield* initTools
      const jobs = yield* BackgroundJob.Service
      const started = yield* tools.shell.execute(
        { command: `bun -e "console.log('界'.repeat(30000) + 777)"`, run_in_background: true },
        makeCtx(),
      )
      const id = startedTaskID(started)
      yield* jobs.wait({ id })
      const result = yield* tools.output.execute({ task_id: id }, makeCtx())
      const tail = result.output.split("\n").slice(2).join("\n")
      expect(tail).not.toContain("\uFFFD")
      expect(tail.trimEnd().endsWith("777")).toBe(true)
      // Permit a small human-readable truncation note regardless of formatting.
      expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(1024 + 128)
      expect(result.metadata).toMatchObject({ truncated: true })
      expect(result.metadata).not.toHaveProperty("outputPath")
    }),
  { config: { tool_output: { max_bytes: 1024, max_lines: 10 } } },
)

it.instance(
  "shell output applies the configured line budget to the tail",
  () =>
    Effect.gen(function* () {
      const tools = yield* initTools
      const jobs = yield* BackgroundJob.Service
      const started = yield* tools.shell.execute(
        { command: `bun -e "for (let i = 1000; i < 1020; i++) console.log(i)"`, run_in_background: true },
        makeCtx(),
      )
      const id = startedTaskID(started)
      yield* jobs.wait({ id })
      const result = yield* tools.output.execute({ task_id: id, tail_lines: 100 }, makeCtx())
      const numeric = result.output.split("\n").filter((line) => /^\d+$/.test(line))
      expect(numeric.at(-1)).toBe("1019")
      expect(numeric.length).toBeLessThanOrEqual(8)
      expect(numeric.length).toBeGreaterThan(0)
      expect(result.metadata).toMatchObject({ truncated: true })
      expect(result.metadata).not.toHaveProperty("outputPath")
    }),
  { config: { tool_output: { max_bytes: 8192, max_lines: 8 } } },
)
