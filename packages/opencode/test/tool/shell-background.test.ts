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
