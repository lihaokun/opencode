import { expect } from "bun:test"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
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
import { testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

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

const makeCtx = (extra?: { promptOps?: AgentManagement.AgentPromptOps }): Tool.Context =>
  ({
    sessionID,
    messageID: MessageID.make("msg_bg_shell"),
    callID: "call_bg",
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
    extra,
  }) as unknown as Tool.Context

const initTools = Effect.gen(function* () {
  const shell = yield* (yield* ShellTool).init()
  const output = yield* (yield* ShellOutputTool).init()
  const kill = yield* (yield* ShellKillTool).init()
  return { shell, output, kill }
})

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
      if (result.output.includes(needle)) return
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
    console.log("DEBUG ids:", JSON.stringify(all.map((j: any) => j.id)), "extracted:", taskId)
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
    const final = (yield* tools.output.execute({ task_id: taskId }, makeCtx())) as { output: string }
    expect(final.output).toContain("status: cancelled")
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

    yield* runState.cancel(sessionID)
    const job = yield* bg.get(taskId)
    expect(job?.status).toBe("cancelled")

    // A cancelled job's run never reaches the delivery step; give the fiber a
    // moment to prove the absence rather than racing it.
    yield* Effect.sleep(500)
    expect(delivered).toHaveLength(0)
    const final = (yield* tools.output.execute({ task_id: taskId }, makeCtx())) as { output: string }
    expect(final.output).toContain("status: cancelled")
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
    expect(final.output.length).toBeLessThan(line.length * 400)

    // Settled runs remove their registry entry; shell_output then falls back
    // to the BackgroundJob snapshot for status and reports the missing tail.
    const output = yield* tools.output.execute({ task_id: taskId }, makeCtx())
    expect(output.output).toContain(`[shell task ${taskId}]`)
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

it.instance("PROBE init shell alone", () =>
  Effect.gen(function* () {
    const info = yield* ShellTool
    const shell = yield* info.init()
    expect(shell.description.length).toBeGreaterThan(0)
  }),
)
