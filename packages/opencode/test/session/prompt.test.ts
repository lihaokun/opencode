import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { eq } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer } from "effect"
import path from "path"
import { fileURLToPath } from "url"
import { NamedError } from "@opencode-ai/core/util/error"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"

import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "@opencode-ai/core/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer, type Usage } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Identifier } from "../../src/id/id"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: SessionV1.Part[]) {
  return parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
}

type CompletedToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }
type ErrorToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateError }

function completedTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

function makeMcp(instructions: MCP.ServerInstructions[] = []) {
  return Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
      instructions: () => Effect.succeed(instructions),
      tools: () => Effect.succeed({}),
      prompts: () => Effect.succeed({}),
      resources: () => Effect.succeed({}),
      resourceTemplates: () => Effect.succeed({}),
      add: () => Effect.succeed({ status: { status: "disabled" as const } }),
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      getPrompt: () => Effect.succeed(undefined),
      readResource: () => Effect.succeed(undefined),
      startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    }),
  )
}

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const processorCreateStarted: Array<() => void> = []
const blockingProcessor = Layer.succeed(
  SessionProcessor.Service,
  SessionProcessor.Service.of({
    create: () => Effect.sync(() => processorCreateStarted.shift()?.()).pipe(Effect.andThen(Effect.never)),
  }),
)

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

const oversizedToolID = "oversized_test_tool"
const oversizedToolPlugin = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    init: () => Effect.void,
    trigger: ((_name: unknown, _input: unknown, output: unknown) =>
      Effect.succeed(output)) as Plugin.Interface["trigger"],
    list: () =>
      Effect.succeed([
        {
          tool: {
            [oversizedToolID]: {
              description: "x".repeat(400_000),
              args: {},
              execute: async () => "ok",
            },
          },
        },
      ]),
  }),
)

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const promptRoot = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
])

function makePrompt(input?: { mcpInstructions?: MCP.ServerInstructions[]; processor?: "blocking" }) {
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp(input?.mcpInstructions)],
    [RuntimeFlags.node, runtimeFlags],
  ] as const
  if (input?.processor === "blocking") {
    return LayerNode.compile(promptRoot, [...replacements, [SessionProcessor.node, blockingProcessor]])
  }
  return LayerNode.compile(promptRoot, replacements)
}

function makeHttp(input?: {
  mcpInstructions?: MCP.ServerInstructions[]
  processor?: "blocking"
  plugin?: "oversized-tool"
}) {
  const root = LayerNode.group([promptRoot, testLLMServerNode])
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp(input?.mcpInstructions)],
    [RuntimeFlags.node, runtimeFlags],
  ] as const
  if (input?.processor === "blocking") {
    return LayerNode.compile(root, [...replacements, [SessionProcessor.node, blockingProcessor]])
  }
  if (input?.plugin === "oversized-tool") {
    return LayerNode.compile(root, [...replacements, [Plugin.node, oversizedToolPlugin]])
  }
  return LayerNode.compile(root, replacements)
}

function makeHttpNoLLMServer(input?: { mcpInstructions?: MCP.ServerInstructions[]; processor?: "blocking" }) {
  return makePrompt(input)
}

const it = testEffect(makeHttp())
const withOversizedTool = testEffect(makeHttp({ plugin: "oversized-tool" }))
const noLLMServer = testEffect(makeHttpNoLLMServer())
const raceNoLLMServer = testEffect(makeHttpNoLLMServer({ processor: "blocking" }))
const withMcpInstructions = testEffect(
  makeHttp({
    mcpInstructions: [
      {
        name: "guide-server",
        instructions: "Use lookup before mutate.",
        tools: ["guide-server_lookup"],
      },
    ],
  }),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip
const unixNoLLMServer = process.platform !== "win32" ? noLLMServer.instance : noLLMServer.instance.skip

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function crossoverCfg(url: string) {
  return providerCfg(url)
}

function preflightCfg(url: string) {
  const config = providerCfg(url)
  return {
    ...config,
    compaction: {
      reserved: 30_000,
      tail_turns: 0,
    },
    provider: {
      ...config.provider,
      test: {
        ...config.provider.test,
        models: {
          ...config.provider.test.models,
          "test-model": {
            ...config.provider.test.models["test-model"],
            limit: {
              ...config.provider.test.models["test-model"].limit,
              input: 100_000,
            },
          },
        },
      },
    },
  }
}

const crossoverUsage = { input: 95_000, output: 1 } satisfies Usage

function usageWithoutFinish(usage: Usage) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [{ delta: {} }],
    usage: {
      prompt_tokens: usage.input,
      completion_tokens: usage.output,
      total_tokens: usage.input + usage.output,
    },
  }
}

function partialWithoutFinish(input: { text?: string; reason?: string; usage: Usage }) {
  const chunk = (delta: Record<string, unknown>) => ({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [{ delta }],
  })
  return raw({
    chunks: [
      chunk({ role: "assistant" }),
      ...(input.reason ? [chunk({ reasoning_content: input.reason })] : []),
      ...(input.text ? [chunk({ content: input.text })] : []),
      usageWithoutFinish(input.usage),
    ],
  })
}

function toolWithoutFinish(name: string, input: unknown, usage?: Usage) {
  const chunk = (delta: Record<string, unknown>) => ({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [{ delta }],
  })
  return raw({
    chunks: [
      chunk({ role: "assistant" }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_incomplete",
            type: "function",
            function: { name, arguments: "" },
          },
        ],
      }),
      chunk({
        tool_calls: [
          {
            index: 0,
            function: { arguments: JSON.stringify(input) },
          },
        ],
      }),
      ...(usage ? [usageWithoutFinish(usage)] : []),
    ],
  })
}

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

// Wait for a session's runner to enter a busy state. SessionStatus is flipped
// inside Runner.startShell's serialized transition, so cancel can't no-op once
// we observe it.
const waitForBusy = (sessionID: SessionID, duration: Duration.Input = "2 seconds") =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const s = yield* status.get(sessionID)
      return s.type === "busy" ? (true as const) : undefined
    }),
    `session ${sessionID} never became busy`,
    duration,
  )

const hasBash = Effect.sync(() => Bun.which("bash") !== null)

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) => {
    Effect.runFork(
      Deferred.await(deferred).pipe(
        Effect.match({
          onFailure: (error) => {
            onrejected?.(error)
          },
          onSuccess: (value) => {
            onfulfilled?.(value)
          },
        }),
      ),
    )
    return deferredAsPromise(deferred) as PromiseLike<never>
  },
})

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const succeedVoid = (deferred: Deferred.Deferred<void>) => {
  Effect.runSync(Deferred.succeed(deferred, void 0).pipe(Effect.ignore))
}

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const seed = Effect.fn("test.seed")(function* (
  sessionID: SessionID,
  opts?: { finish?: string; userText?: string; assistantText?: string },
) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, opts?.userText ?? "hello")
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: opts?.assistantText ?? "hi there",
  })
  return { user: msg, assistant }
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model,
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const config = yield* Config.Service
  const prompt = yield* SessionPrompt.Service
  const run = yield* SessionRunState.Service
  const sessions = yield* Session.Service
  yield* config.get()
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, run, sessions, chat }
})

// Loop semantics

noLLMServer.instance(
  "loop exits immediately when last assistant has stop finish",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
    }),
  { config: cfg },
)

noLLMServer.instance(
  "loop exits without a provider request across the message ID rollover",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const before = 2 ** 36 - 2
      const after = 2 ** 36 + 1
      const preWrapUserID = MessageID.make(Identifier.create("msg", "ascending", before))
      const preWrapAssistantID = MessageID.make(Identifier.create("msg", "ascending", before + 1))
      const postWrapUserID = MessageID.make(Identifier.create("msg", "ascending", after))
      const terminalAssistantID = MessageID.make(Identifier.create("msg", "ascending", after + 1))
      yield* sessions.updateMessage({
        id: preWrapUserID,
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: before },
      })
      yield* sessions.updateMessage({
        id: preWrapAssistantID,
        role: "assistant",
        parentID: preWrapUserID,
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: before + 1 },
        finish: "tool-calls",
      })
      yield* sessions.updateMessage({
        id: postWrapUserID,
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: after },
      })
      yield* sessions.updateMessage({
        id: terminalAssistantID,
        role: "assistant",
        // Production assistants created during the rollover inherited the
        // pre-wrap user selected by the old raw-ID latest() implementation.
        parentID: preWrapUserID,
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: after + 1 },
        finish: "stop",
      })

      const result = yield* prompt.loop({ sessionID: chat.id })

      expect(preWrapUserID > terminalAssistantID).toBe(true)
      expect(preWrapAssistantID > terminalAssistantID).toBe(true)
      expect(postWrapUserID).not.toBe(preWrapUserID)
      expect(result.info.id).toBe(terminalAssistantID)
    }),
  { config: cfg },
)

it.instance("loop exits without an LLM request for interrupted orphan tool calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const seeded = yield* seed(chat.id, { finish: "stop" })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: seeded.assistant.id,
      sessionID: chat.id,
      type: "tool",
      callID: "interrupted-call",
      tool: "edit",
      state: {
        status: "error",
        input: {},
        error: "Tool execution aborted",
        metadata: { interrupted: true },
        time: { start: 1, end: 2 },
      },
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.id).toBe(seeded.assistant.id)
    expect(yield* llm.hits).toHaveLength(0)
  }),
)

it.instance("loop does not replay a persisted assistant error with a completed tool", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const seeded = yield* seed(chat.id)
    seeded.assistant.error = new NamedError.Unknown({ message: "persisted provider failure" }).toObject()
    yield* sessions.updateMessage(seeded.assistant)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: seeded.assistant.id,
      sessionID: chat.id,
      type: "tool",
      callID: "completed-call",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "README.md" },
        output: "done",
        title: "README.md",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    })
    yield* llm.text("must not replay")

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(result.info.id).toBe(seeded.assistant.id)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.error).toEqual(seeded.assistant.error)
    }
    expect(yield* llm.hits).toHaveLength(0)
  }),
)

it.instance("loop allows a new user message after a persisted assistant error", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const seeded = yield* seed(chat.id)
    seeded.assistant.error = new NamedError.Unknown({ message: "persisted provider failure" }).toObject()
    yield* sessions.updateMessage(seeded.assistant)
    yield* user(chat.id, "try again")
    yield* llm.text("recovered")

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(result.info.id).not.toBe(seeded.assistant.id)
    expect(result.parts).toContainEqual(expect.objectContaining({ type: "text", text: "recovered" }))
    expect(yield* llm.hits).toHaveLength(1)
  }),
)

it.instance("loop calls LLM and returns assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    const parts = result.parts.filter((p) => p.type === "text")
    expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
  }),
)

withMcpInstructions.instance(
  "loop includes MCP instructions in model system context",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "timed out waiting for MCP instruction request", "10 seconds")

      const hits = yield* llm.hits
      const body = JSON.stringify(hits[0]?.body)
      expect(body).toContain('<server name=\\"guide-server\\">')
      expect(body).toContain("Use lookup before mutate.")
      yield* Fiber.interrupt(fiber)
    }),
  15_000,
)

it.instance("legacy prompt emits message events without session.next events", () =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      agent: "plan",
      model: { providerID: ProviderV2.ID.make("old"), id: ModelV2.ID.make("old-model") },
    })
    const seen: string[] = []
    const off = yield* events.listen((event) => {
      seen.push(event.type)
      return Effect.void
    })

    const first = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: ref,
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    const second = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "again" }],
    })
    yield* off

    expect(first.info.role).toBe("user")
    expect(second.info.role).toBe("user")
    if (first.info.role === "user" && second.info.role === "user") {
      expect(first.info.model).toEqual(ref)
      expect(second.info.model).toEqual(ref)
    }
    expect(yield* sessions.get(chat.id)).toMatchObject({
      agent: "build",
      model: { providerID: ref.providerID, id: ref.modelID },
    })
    expect(seen).toContain(Session.Event.Updated.type)
    expect(seen).toContain(MessageV2.Event.Updated.type)
    expect(seen).toContain(MessageV2.Event.PartUpdated.type)
    expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
  }),
)

it.instance("loop surfaces content-filter finishes as session errors", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const errors: NonNullable<SessionV1.Assistant["error"]>[] = []
    const expected = {
      name: "ContentFilterError",
      data: { message: "The response was blocked by the provider's content filter" },
    } satisfies NonNullable<SessionV1.Assistant["error"]>
    const off = yield* events.listen((event) => {
      if (event.type !== Session.Event.Error.type) return Effect.void
      const data = event.data as typeof Session.Event.Error.data.Type
      if (data.sessionID === chat.id && data.error) errors.push(data.error)
      return Effect.void
    })

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().text("partial response").contentFilter())

    const result = yield* prompt.loop({ sessionID: chat.id })
    const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: result.info.id })
    yield* off

    expect(yield* llm.hits).toHaveLength(1)
    expect(result.info.role).toBe("assistant")
    expect(stored.info.role).toBe("assistant")
    if (result.info.role === "assistant" && stored.info.role === "assistant") {
      expect(result.info.finish).toBe("content-filter")
      expect(result.info.error).toEqual(expected)
      expect(stored.info.error).toEqual(result.info.error)
      expect(errors).toContainEqual(expected)
    }
    expect(result.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text", text: "partial response" })]),
    )
  }),
)

it.instance("loop persists length without visible output and publishes one error", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const errors: NonNullable<SessionV1.Assistant["error"]>[] = []
    const off = yield* events.listen((event) => {
      if (event.type !== Session.Event.Error.type) return Effect.void
      const data = event.data as typeof Session.Event.Error.data.Type
      if (data.sessionID === chat.id && data.error) errors.push(data.error)
      return Effect.void
    })

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "truncate" }],
    })
    yield* llm.push(reply().usage({ input: 10, output: 10 }).length())

    const result = yield* prompt.loop({ sessionID: chat.id })
    const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: result.info.id })
    yield* off

    expect(yield* llm.hits).toHaveLength(1)
    expect(result.info.role).toBe("assistant")
    expect(stored.info.role).toBe("assistant")
    if (result.info.role === "assistant" && stored.info.role === "assistant") {
      expect(result.info.finish).toBe("length")
      expect(result.info.error?.name).toBe("MessageOutputLengthError")
      expect(stored.info.finish).toBe("length")
      expect(stored.info.error).toEqual(result.info.error)
    }
    expect(result.parts.some((part) => part.type === "text")).toBe(false)
    expect(errors.map((error) => error.name)).toEqual(["MessageOutputLengthError"])
  }),
)

it.instance("loop preserves partial text and reasoning on length without replay", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const errors: NonNullable<SessionV1.Assistant["error"]>[] = []
    const off = yield* events.listen((event) => {
      if (event.type !== Session.Event.Error.type) return Effect.void
      const data = event.data as typeof Session.Event.Error.data.Type
      if (data.sessionID === chat.id && data.error) errors.push(data.error)
      return Effect.void
    })

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "truncate with partial" }],
    })
    yield* llm.push(
      reply().reason("unfinished reasoning").text("partial answer").usage({ input: 12, output: 8 }).length(),
    )

    const result = yield* prompt.loop({ sessionID: chat.id })
    const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: result.info.id })
    yield* off

    expect(yield* llm.hits).toHaveLength(1)
    expect(yield* llm.pending).toBe(0)
    expect(result.info.role).toBe("assistant")
    expect(stored.info.role).toBe("assistant")
    if (result.info.role === "assistant" && stored.info.role === "assistant") {
      expect(result.info.finish).toBe("length")
      expect(result.info.error?.name).toBe("MessageOutputLengthError")
      expect(stored.info.error).toEqual(result.info.error)
    }
    expect(result.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "reasoning", text: "unfinished reasoning" }),
        expect.objectContaining({ type: "text", text: "partial answer" }),
      ]),
    )
    expect(errors.map((error) => error.name)).toEqual(["MessageOutputLengthError"])
  }),
)

it.instance("loop preserves reasoning-only output and stops on a missing terminal finish", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "reason without a finish" }],
    })
    yield* llm.push(reply().reason("unfinished reasoning"))

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(yield* llm.hits).toHaveLength(1)
    expect(yield* llm.pending).toBe(0)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.finish).toBe("unknown")
      expect(result.info.error).toMatchObject({
        name: "UnknownError",
        data: { message: "Provider stream ended without a terminal finish event" },
      })
    }
    expect(result.parts).toContainEqual(expect.objectContaining({ type: "reasoning", text: "unfinished reasoning" }))
  }),
)

it.instance("loop preserves partial text and stops on a missing terminal finish", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "text without a finish" }],
    })
    yield* llm.push(reply().text("partial answer"))

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(yield* llm.hits).toHaveLength(1)
    expect(yield* llm.pending).toBe(0)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.finish).toBe("unknown")
      expect(result.info.error).toMatchObject({
        name: "UnknownError",
        data: { message: "Provider stream ended without a terminal finish event" },
      })
    }
    expect(result.parts).toContainEqual(expect.objectContaining({ type: "text", text: "partial answer" }))
  }),
)

it.instance("loop persists a high-usage missing finish without compaction or replay", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(crossoverCfg)
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const errors: NonNullable<SessionV1.Assistant["error"]>[] = []
    const compacted: (typeof SessionCompaction.Event.Compacted.data.Type)[] = []
    const off = yield* events.listen((event) => {
      if (event.type === Session.Event.Error.type) {
        const data = event.data as typeof Session.Event.Error.data.Type
        if (data.sessionID === chat.id && data.error) errors.push(data.error)
      }
      if (event.type === SessionCompaction.Event.Compacted.type) {
        const data = event.data as typeof SessionCompaction.Event.Compacted.data.Type
        if (data.sessionID === chat.id) compacted.push(data)
      }
      return Effect.void
    })

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "crossover partial marker" }],
    })
    yield* llm.push(partialWithoutFinish({ text: "partial crossover answer", usage: crossoverUsage }))

    const result = yield* prompt.loop({ sessionID: chat.id })
    const replay = yield* prompt.loop({ sessionID: chat.id })
    const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: result.info.id })
    const messages = yield* sessions.messages({ sessionID: chat.id })
    yield* off

    const hits = yield* llm.hits
    expect(hits).toHaveLength(1)
    expect(JSON.stringify(hits[0]?.body)).toContain("crossover partial marker")
    expect(yield* llm.pending).toBe(0)
    expect(replay.info.id).toBe(result.info.id)
    expect(result.info.role).toBe("assistant")
    expect(stored.info.role).toBe("assistant")
    if (result.info.role === "assistant" && stored.info.role === "assistant") {
      expect(result.info.finish).toBe("unknown")
      expect(result.info.error).toMatchObject({
        name: "UnknownError",
        data: { message: "Provider stream ended without a terminal finish event" },
      })
      expect(result.info.tokens).toMatchObject({ input: 95_000, output: 1, total: 95_001 })
      expect(result.info.time.completed).toBeNumber()
      expect(stored.info.finish).toBe(result.info.finish)
      expect(stored.info.error).toEqual(result.info.error)
      expect(stored.info.time.completed).toBe(result.info.time.completed)
    }
    expect(result.parts).toContainEqual(expect.objectContaining({ type: "text", text: "partial crossover answer" }))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      name: "UnknownError",
      data: { message: "Provider stream ended without a terminal finish event" },
    })
    expect(compacted).toHaveLength(0)
    expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(false)
    expect(messages.some((message) => message.info.role === "assistant" && message.info.summary)).toBe(false)
  }),
)

it.instance("high-usage missing finish prevents StructuredOutput promotion and compaction", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(crossoverCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      format: new SessionV1.OutputFormatJsonSchema({
        type: "json_schema",
        schema: {
          type: "object",
          properties: { result: { type: "number" } },
          required: ["result"],
          additionalProperties: false,
        },
        retryCount: 0,
      }),
      parts: [{ type: "text", text: "crossover structured marker" }],
    })
    yield* llm.push(toolWithoutFinish("StructuredOutput", { result: 2 }, crossoverUsage))

    const result = yield* prompt.loop({ sessionID: chat.id })
    const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: result.info.id })
    const messages = yield* sessions.messages({ sessionID: chat.id })
    const hits = yield* llm.hits

    expect(hits).toHaveLength(1)
    expect(JSON.stringify(hits[0]?.body)).toContain("crossover structured marker")
    expect(yield* llm.pending).toBe(0)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.finish).toBe("unknown")
      expect(result.info.error).toMatchObject({
        name: "UnknownError",
        data: { message: "Provider stream ended without a terminal finish event" },
      })
      expect(result.info.structured).toBeUndefined()
      expect(result.info.tokens).toMatchObject({ input: 95_000, output: 1, total: 95_001 })
    }
    const output = completedTool(result.parts)
    expect(output?.tool).toBe("StructuredOutput")
    expect(stored.info.role).toBe("assistant")
    if (stored.info.role === "assistant") {
      expect(stored.info.error).toEqual(result.info.role === "assistant" ? result.info.error : undefined)
      expect(stored.info.structured).toBeUndefined()
    }
    expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(false)
    expect(messages.some((message) => message.info.role === "assistant" && message.info.summary)).toBe(false)
  }),
)

unix("high-usage missing finish does not replay a completed tool or start compaction", () =>
  Effect.gen(function* () {
    if (!(yield* hasBash)) return
    const { dir, llm } = yield* useServerConfig(crossoverCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const marker = path.join(dir, "crossover-tool-count.txt")

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "crossover completed tool marker" }],
    })
    yield* llm.push(
      reply().tool("bash", {
        command: `printf 'charged\\n' >> '${marker}'`,
        description: "Append one crossover marker",
      }),
      partialWithoutFinish({ reason: "cut off after completed tool", usage: crossoverUsage }),
    )

    const result = yield* withSh(() => prompt.loop({ sessionID: chat.id }))
    const replay = yield* prompt.loop({ sessionID: chat.id })
    const messages = yield* sessions.messages({ sessionID: chat.id })
    const hits = yield* llm.hits

    expect(hits).toHaveLength(2)
    expect(hits.every((hit) => JSON.stringify(hit.body).includes("crossover completed tool marker"))).toBe(true)
    expect(yield* llm.pending).toBe(0)
    expect(replay.info.id).toBe(result.info.id)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.finish).toBe("unknown")
      expect(result.info.error).toMatchObject({
        name: "UnknownError",
        data: { message: "Provider stream ended without a terminal finish event" },
      })
      expect(result.info.tokens).toMatchObject({ input: 95_000, output: 1, total: 95_001 })
    }
    expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("charged\n")
    expect(
      messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool" && part.tool === "bash" && part.state.status === "completed"),
    ).toHaveLength(1)
    expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(false)
    expect(messages.some((message) => message.info.role === "assistant" && message.info.summary)).toBe(false)
  }),
)

unix("loop does not replay a completed tool after a later length finish", () =>
  Effect.gen(function* () {
    if (!(yield* hasBash)) return
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const marker = path.join(dir, "charged.txt")

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "run once" }],
    })
    yield* llm.push(
      reply().tool("bash", {
        command: `printf 'charged\\n' >> '${marker}'`,
        description: "Append one marker",
      }),
      reply().length(),
    )

    const result = yield* withSh(() => prompt.loop({ sessionID: chat.id }))

    expect(yield* llm.hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") expect(result.info.error?.name).toBe("MessageOutputLengthError")
    expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("charged\n")
  }),
)

unix("loop does not replay a completed tool after a later missing terminal finish", () =>
  Effect.gen(function* () {
    if (!(yield* hasBash)) return
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const marker = path.join(dir, "incomplete-charged.txt")

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "run once then truncate" }],
    })
    yield* llm.push(
      reply().tool("bash", {
        command: `printf 'charged\\n' >> '${marker}'`,
        description: "Append one marker",
      }),
      reply().reason("cut off after tool"),
    )

    const result = yield* withSh(() => prompt.loop({ sessionID: chat.id }))

    expect(yield* llm.hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.error).toMatchObject({
        name: "UnknownError",
        data: { message: "Provider stream ended without a terminal finish event" },
      })
    }
    expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("charged\n")
  }),
)

it.instance("length wins over a successful StructuredOutput tool result", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      format: new SessionV1.OutputFormatJsonSchema({
        type: "json_schema",
        schema: {
          type: "object",
          properties: { result: { type: "number" } },
          required: ["result"],
          additionalProperties: false,
        },
        retryCount: 0,
      }),
      parts: [{ type: "text", text: "return structured output" }],
    })
    yield* llm.push(reply().tool("StructuredOutput", { result: 2 }).length())

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(yield* llm.hits).toHaveLength(1)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.finish).toBe("length")
      expect(result.info.error?.name).toBe("MessageOutputLengthError")
      expect(result.info.structured).toBeUndefined()
    }
  }),
)

it.instance("a missing terminal finish wins over a successful StructuredOutput tool result", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      format: new SessionV1.OutputFormatJsonSchema({
        type: "json_schema",
        schema: {
          type: "object",
          properties: { result: { type: "number" } },
          required: ["result"],
          additionalProperties: false,
        },
        retryCount: 0,
      }),
      parts: [{ type: "text", text: "return incomplete structured output" }],
    })
    yield* llm.push(toolWithoutFinish("StructuredOutput", { result: 2 }))

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(yield* llm.hits).toHaveLength(1)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.finish).toBe("unknown")
      expect(result.info.error).toMatchObject({
        name: "UnknownError",
        data: { message: "Provider stream ended without a terminal finish event" },
      })
      expect(result.info.structured).toBeUndefined()
    }
  }),
)

it.instance(
  "loop compacts oversized history before send and fully replays the current user turn",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(preflightCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const oldMarker = "old-history-preflight-marker"
      const currentMarker = "current-turn-replay-marker"
      const detailMarker = "current-turn-second-part"
      const systemMarker = "current-turn-system-marker"
      const summaryMarker = "compacted-history-marker"
      const answerMarker = "recovered-after-preflight-marker"

      yield* seed(chat.id, {
        finish: "stop",
        userText: `${oldMarker}\n${"x".repeat(280_000)}`,
        assistantText: "old assistant response",
      })
      const original = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        tools: { bash: false },
        system: systemMarker,
        parts: [
          { type: "text", text: currentMarker },
          { type: "text", text: detailMarker },
        ],
      })
      yield* llm.textMatch((hit) => {
        const body = JSON.stringify(hit.body)
        return body.includes(oldMarker) && !body.includes(currentMarker)
      }, summaryMarker)
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes(currentMarker), answerMarker)

      const result = yield* awaitWithTimeout(
        prompt.loop({ sessionID: chat.id }),
        "preflight compaction recovery did not terminate",
        "10 seconds",
      )
      const hits = yield* llm.hits
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const active = yield* MessageV2.filterCompactedEffect(chat.id)
      const summaryBody = JSON.stringify(hits[0]?.body)
      const finalBody = JSON.stringify(hits[1]?.body)

      expect(hits).toHaveLength(2)
      expect(yield* llm.pending).toBe(0)
      expect(summaryBody).toContain(oldMarker)
      expect(summaryBody).not.toContain(currentMarker)
      expect(summaryBody).not.toContain(detailMarker)
      expect(finalBody).toContain(summaryMarker)
      expect(finalBody).toContain(currentMarker)
      expect(finalBody).toContain(detailMarker)
      expect(finalBody).toContain(systemMarker)
      expect(finalBody).not.toContain(oldMarker)
      expect(finalBody.split(currentMarker)).toHaveLength(2)
      expect(finalBody.split(detailMarker)).toHaveLength(2)

      const compactions = messages.flatMap((message) =>
        message.parts.filter((part): part is SessionV1.CompactionPart => part.type === "compaction"),
      )
      expect(compactions).toHaveLength(1)
      expect(compactions[0]).toMatchObject({ auto: true, overflow: true })
      const summaries = messages.filter((message) => message.info.role === "assistant" && message.info.summary)
      expect(summaries).toHaveLength(1)
      expect(summaries[0]?.parts).toContainEqual(expect.objectContaining({ type: "text", text: summaryMarker }))

      const markerUsers = messages.filter(
        (message) =>
          message.info.role === "user" &&
          message.parts.some((part) => part.type === "text" && part.text === currentMarker),
      )
      expect(markerUsers).toHaveLength(2)
      expect(
        active.filter(
          (message) =>
            message.info.role === "user" &&
            message.parts.some((part) => part.type === "text" && part.text === currentMarker),
        ),
      ).toHaveLength(1)
      const replay = markerUsers.find((message) => message.info.id !== original.info.id)
      if (!replay || replay.info.role !== "user" || original.info.role !== "user") {
        throw new Error("Expected one replayed user message")
      }
      expect(replay.info.agent).toBe(original.info.agent)
      expect(replay.info.model.providerID).toBe(original.info.model.providerID)
      expect(replay.info.model.modelID).toBe(original.info.model.modelID)
      expect(replay.info.model.variant).toBe(original.info.model.variant)
      expect(replay.info.system).toBe(original.info.system)
      expect(replay.info.tools).toEqual(original.info.tools)
      expect(replay.info.format).toEqual(original.info.format)
      expect(
        replay.parts.filter((part): part is SessionV1.TextPart => part.type === "text").map((part) => part.text),
      ).toEqual(
        original.parts.filter((part): part is SessionV1.TextPart => part.type === "text").map((part) => part.text),
      )
      expect(
        messages.filter((message) => message.info.role === "assistant" && message.info.parentID === original.info.id),
      ).toHaveLength(0)

      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.info.parentID).toBe(replay.info.id)
        expect(result.info.finish).toBe("stop")
        expect(result.info.error).toBeUndefined()
      }
      expect(result.parts).toContainEqual(expect.objectContaining({ type: "text", text: answerMarker }))
    }),
  15_000,
)

it.instance(
  "overflow compaction tokens stay isolated across concurrent sessions",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(preflightCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const first = yield* sessions.create({ title: "Pinned" })
      const second = yield* sessions.create({ title: "Pinned" })
      const gate = yield* Deferred.make<void>()
      const firstMarker = "isolated-overflow-first-marker"
      const secondMarker = "isolated-overflow-second-marker"
      const firstSummary = "isolated-overflow-first-summary"
      const secondSummary = "isolated-overflow-second-summary"
      const firstAnswer = "isolated-overflow-first-answer"
      const secondAnswer = "isolated-overflow-second-answer"

      yield* seed(first.id, { finish: "stop", userText: `${firstMarker}-old\n${"x".repeat(280_000)}` })
      yield* seed(second.id, { finish: "stop", userText: `${secondMarker}-old\n${"x".repeat(280_000)}` })
      yield* prompt.prompt({
        sessionID: first.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: firstMarker }],
      })
      yield* prompt.prompt({
        sessionID: second.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: secondMarker }],
      })
      yield* llm.push(
        reply().wait(deferredAsPromise(gate)).text(firstSummary).stop(),
        reply().text(secondSummary).stop(),
        reply().text(secondAnswer).stop(),
        reply().text(firstAnswer).stop(),
      )

      const firstRun = yield* prompt.loop({ sessionID: first.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "first session did not enter compaction", "5 seconds")
      const secondResult = yield* awaitWithTimeout(
        prompt.loop({ sessionID: second.id }),
        "second session inherited the first session's compaction token",
        "10 seconds",
      )
      yield* Deferred.succeed(gate, void 0)
      const firstResult = yield* awaitWithTimeout(
        Fiber.join(firstRun),
        "first session did not finish after its summary was released",
        "10 seconds",
      )

      const hits = yield* llm.hits
      const firstMessages = yield* sessions.messages({ sessionID: first.id })
      const secondMessages = yield* sessions.messages({ sessionID: second.id })
      expect(hits).toHaveLength(4)
      expect(JSON.stringify(hits[0]?.body)).toContain(`${firstMarker}-old`)
      expect(JSON.stringify(hits[1]?.body)).toContain(`${secondMarker}-old`)
      expect(JSON.stringify(hits[2]?.body)).toContain(secondMarker)
      expect(JSON.stringify(hits[3]?.body)).toContain(firstMarker)
      expect(
        firstMessages.flatMap((message) => message.parts).filter((part) => part.type === "compaction"),
      ).toHaveLength(1)
      expect(
        secondMessages.flatMap((message) => message.parts).filter((part) => part.type === "compaction"),
      ).toHaveLength(1)
      expect(firstResult.parts).toContainEqual(expect.objectContaining({ type: "text", text: firstAnswer }))
      expect(secondResult.parts).toContainEqual(expect.objectContaining({ type: "text", text: secondAnswer }))
    }),
  20_000,
)

it.instance(
  "post-overflow usage compaction does not create another overflow recovery",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(preflightCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const currentMarker = "post-overflow-usage-current-marker"
      const finalMarker = "post-overflow-usage-final-marker"

      yield* seed(chat.id, {
        finish: "stop",
        userText: `post-overflow-usage-old-marker\n${"x".repeat(280_000)}`,
      })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: currentMarker }],
      })
      yield* llm.text("post-overflow-usage-first-summary")
      yield* llm.text("post-overflow-usage-high-usage-answer", { usage: { input: 100_001, output: 1 } })
      yield* llm.text("post-overflow-usage-second-summary")
      yield* llm.text(finalMarker)

      const result = yield* awaitWithTimeout(
        Effect.raceFirst(prompt.loop({ sessionID: chat.id }), llm.wait(5).pipe(Effect.as("repeated" as const))),
        "usage compaction after overflow recovery did not converge",
        "10 seconds",
      )

      expect(result).not.toBe("repeated")
      if (result === "repeated") return
      const hits = yield* llm.hits
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const compactions = messages
        .flatMap((message) => message.parts)
        .filter((part): part is SessionV1.CompactionPart => part.type === "compaction")
      expect(hits).toHaveLength(4)
      expect(compactions).toHaveLength(2)
      expect(compactions.filter((part) => part.overflow === true)).toHaveLength(1)
      expect(messages.filter((message) => message.info.role === "assistant" && message.info.summary)).toHaveLength(2)
      expect(JSON.stringify(hits[1]?.body)).toContain(currentMarker)
      expect(result.parts).toContainEqual(expect.objectContaining({ type: "text", text: finalMarker }))
    }),
  20_000,
)

it.instance("loop compacts and replays once after provider context overflow", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const currentMarker = "provider-overflow-current-marker"
    const detailMarker = "provider-overflow-detail-marker"
    const systemMarker = "provider-overflow-system-marker"
    const summaryMarker = "provider-overflow-summary-marker"
    const answerMarker = "provider-overflow-recovered-marker"

    yield* seed(chat.id, { finish: "stop" })
    const original = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      tools: { bash: false },
      system: systemMarker,
      parts: [
        { type: "text", text: currentMarker },
        { type: "text", text: detailMarker },
      ],
    })
    yield* llm.error(400, { error: { message: "Prompt exceeds max length" } })
    yield* llm.text(summaryMarker)
    yield* llm.text(answerMarker)

    const result = yield* awaitWithTimeout(
      prompt.loop({ sessionID: chat.id }),
      "provider overflow recovery did not terminate",
      "10 seconds",
    )
    const hits = yield* llm.hits
    const messages = yield* sessions.messages({ sessionID: chat.id })
    const active = yield* MessageV2.filterCompactedEffect(chat.id)
    const firstBody = JSON.stringify(hits[0]?.body)
    const summaryBody = JSON.stringify(hits[1]?.body)
    const finalBody = JSON.stringify(hits[2]?.body)

    expect(hits).toHaveLength(3)
    expect(yield* llm.pending).toBe(0)
    expect(firstBody).toContain(currentMarker)
    expect(summaryBody).not.toContain(currentMarker)
    expect(summaryBody).not.toContain(detailMarker)
    expect(finalBody).toContain(summaryMarker)
    expect(finalBody).toContain(currentMarker)
    expect(finalBody).toContain(detailMarker)
    expect(finalBody).toContain(systemMarker)
    expect(finalBody.split(currentMarker)).toHaveLength(2)
    expect(finalBody.split(detailMarker)).toHaveLength(2)

    const markerUsers = messages.filter(
      (message) =>
        message.info.role === "user" &&
        message.parts.some((part) => part.type === "text" && part.text === currentMarker),
    )
    expect(markerUsers).toHaveLength(2)
    expect(
      active.filter(
        (message) =>
          message.info.role === "user" &&
          message.parts.some((part) => part.type === "text" && part.text === currentMarker),
      ),
    ).toHaveLength(1)
    const replay = markerUsers.find((message) => message.info.id !== original.info.id)
    if (!replay || replay.info.role !== "user" || original.info.role !== "user") {
      throw new Error("Expected one replayed user message")
    }
    expect(replay.info.agent).toBe(original.info.agent)
    expect(replay.info.model.providerID).toBe(original.info.model.providerID)
    expect(replay.info.model.modelID).toBe(original.info.model.modelID)
    expect(replay.info.model.variant).toBe(original.info.model.variant)
    expect(replay.info.system).toBe(original.info.system)
    expect(replay.info.tools).toEqual(original.info.tools)
    expect(
      replay.parts.filter((part): part is SessionV1.TextPart => part.type === "text").map((part) => part.text),
    ).toEqual(
      original.parts.filter((part): part is SessionV1.TextPart => part.type === "text").map((part) => part.text),
    )
    expect(messages.flatMap((message) => message.parts).filter((part) => part.type === "compaction")).toHaveLength(1)
    expect(messages.filter((message) => message.info.role === "assistant" && message.info.summary)).toHaveLength(1)

    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.parentID).toBe(replay.info.id)
      expect(result.info.finish).toBe("stop")
      expect(result.info.error).toBeUndefined()
    }
    expect(result.parts).toContainEqual(expect.objectContaining({ type: "text", text: answerMarker }))
  }),
)

it.instance("loop persists a second provider context overflow after one recovery", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const currentMarker = "provider-second-overflow-current-marker"
    const summaryMarker = "provider-second-overflow-summary-marker"

    yield* seed(chat.id, { finish: "stop" })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: currentMarker }],
    })
    yield* llm.error(413, { error: { message: "request entity too large" } })
    yield* llm.text(summaryMarker)
    yield* llm.error(413, { error: { message: "request entity too large" } })

    const result = yield* awaitWithTimeout(
      Effect.raceFirst(prompt.loop({ sessionID: chat.id }), llm.wait(4).pipe(Effect.as("repeated" as const))),
      "second provider overflow neither terminated nor retried compaction",
      "5 seconds",
    )

    expect(result).not.toBe("repeated")
    if (result === "repeated") return
    const hits = yield* llm.hits
    const messages = yield* sessions.messages({ sessionID: chat.id })
    const active = yield* MessageV2.filterCompactedEffect(chat.id)
    const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: result.info.id })
    const ids = messages.map((message) => message.info.id)

    expect(hits).toHaveLength(3)
    expect(yield* llm.pending).toBe(0)
    expect(result.info.role).toBe("assistant")
    expect(stored.info.role).toBe("assistant")
    if (result.info.role === "assistant" && stored.info.role === "assistant") {
      expect(result.info.finish).toBe("error")
      expect(result.info.error?.name).toBe("ContextOverflowError")
      expect(result.info.error).toMatchObject({
        name: "ContextOverflowError",
        data: { message: expect.stringContaining("request entity too large") },
      })
      expect(result.info.time.completed).toBeNumber()
      expect(stored.info.finish).toBe(result.info.finish)
      expect(stored.info.error).toEqual(result.info.error)
      expect(stored.info.time.completed).toBe(result.info.time.completed)
    }
    expect(messages.flatMap((message) => message.parts).filter((part) => part.type === "compaction")).toHaveLength(1)
    expect(messages.filter((message) => message.info.role === "assistant" && message.info.summary)).toHaveLength(1)
    expect(
      messages.filter(
        (message) =>
          message.info.role === "user" &&
          message.parts.some((part) => part.type === "text" && part.text === currentMarker),
      ),
    ).toHaveLength(2)
    expect(
      active.filter(
        (message) =>
          message.info.role === "user" &&
          message.parts.some((part) => part.type === "text" && part.text === currentMarker),
      ),
    ).toHaveLength(1)
    expect(active.at(-1)?.info.id).toBe(result.info.id)
    expect(
      messages
        .flatMap((message) => message.parts)
        .some((part) => part.type === "text" && part.metadata && part.metadata.compaction_continue === true),
    ).toBe(false)

    const replay = yield* prompt.loop({ sessionID: chat.id })
    expect(replay.info.id).toBe(result.info.id)
    expect((yield* sessions.messages({ sessionID: chat.id })).map((message) => message.info.id)).toEqual(ids)
    expect(yield* llm.hits).toHaveLength(3)

    const nextMarker = "provider-overflow-next-run-marker"
    const nextAnswer = "provider-overflow-next-run-answer"
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: nextMarker }],
    })
    yield* llm.error(413, { error: { message: "request entity too large" } })
    yield* llm.text("provider-overflow-next-run-summary")
    yield* llm.text(nextAnswer)

    const next = yield* awaitWithTimeout(
      prompt.loop({ sessionID: chat.id }),
      "a new run did not receive a fresh overflow recovery allowance",
      "10 seconds",
    )
    const nextMessages = yield* sessions.messages({ sessionID: chat.id })
    expect(yield* llm.hits).toHaveLength(6)
    expect(nextMessages.flatMap((message) => message.parts).filter((part) => part.type === "compaction")).toHaveLength(
      2,
    )
    expect(nextMessages.filter((message) => message.info.role === "assistant" && message.info.summary)).toHaveLength(2)
    expect(next.info.role).toBe("assistant")
    if (next.info.role === "assistant") {
      expect(next.info.finish).toBe("stop")
      expect(next.info.error).toBeUndefined()
    }
    expect(next.parts).toContainEqual(expect.objectContaining({ type: "text", text: nextAnswer }))
  }),
)

it.instance("loop sends an oversized current-only user turn once without compaction", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const marker = "oversized-current-user-marker"
    const submitted = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: `${marker}\n${"x".repeat(400_000)}` }],
    })
    yield* llm.error(413, { error: { message: "request entity too large" } })

    const result = yield* awaitWithTimeout(
      Effect.raceFirst(prompt.loop({ sessionID: chat.id }), llm.wait(2).pipe(Effect.as("repeated" as const))),
      "oversized current user message neither terminated nor repeated recovery",
      "5 seconds",
    )

    expect(result).not.toBe("repeated")
    if (result === "repeated") return
    const hits = yield* llm.hits
    const messages = yield* sessions.messages({ sessionID: chat.id })
    const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: result.info.id })
    const ids = messages.map((message) => message.info.id)

    expect(hits).toHaveLength(1)
    expect(JSON.stringify(hits[0]?.body)).toContain(marker)
    expect(yield* llm.pending).toBe(0)
    expect(messages.filter((message) => message.info.id === submitted.info.id)).toHaveLength(1)
    expect(messages.filter((message) => message.info.role === "user")).toHaveLength(1)
    expect(messages.filter((message) => message.info.role === "assistant")).toHaveLength(1)
    expect(messages.flatMap((message) => message.parts).filter((part) => part.type === "compaction")).toHaveLength(0)
    expect(messages.some((message) => message.info.role === "assistant" && message.info.summary)).toBe(false)
    expect(result.info.role).toBe("assistant")
    expect(stored.info.role).toBe("assistant")
    if (result.info.role === "assistant" && stored.info.role === "assistant") {
      expect(result.info.parentID).toBe(submitted.info.id)
      expect(result.info.finish).toBe("error")
      expect(result.info.error).toMatchObject({
        name: "ContextOverflowError",
        data: {
          message: expect.stringContaining("request entity too large"),
          responseBody: JSON.stringify({ error: { message: "request entity too large" } }),
        },
      })
      expect(result.info.time.completed).toBeNumber()
      expect(stored.info.finish).toBe(result.info.finish)
      expect(stored.info.error).toEqual(result.info.error)
      expect(stored.info.time.completed).toBe(result.info.time.completed)
    }

    const replay = yield* prompt.loop({ sessionID: chat.id })
    expect(replay.info.id).toBe(result.info.id)
    expect((yield* sessions.messages({ sessionID: chat.id })).map((message) => message.info.id)).toEqual(ids)
    expect(yield* llm.hits).toHaveLength(1)
  }),
)

it.instance("loop accounts for prompt-specific system text before sending", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const oldMarker = "prompt-system-old-history-marker"
    const currentMarker = "prompt-system-current-marker"
    const systemMarker = "oversized-prompt-system-marker"
    const summaryMarker = "prompt-system-summary-marker"

    yield* seed(chat.id, { finish: "stop", userText: oldMarker })
    const submitted = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      system: `${systemMarker}\n${"x".repeat(400_000)}`,
      parts: [{ type: "text", text: currentMarker }],
    })
    yield* llm.text(summaryMarker)
    yield* llm.error(413, { error: { message: "request entity too large" } })

    const result = yield* awaitWithTimeout(
      Effect.raceFirst(prompt.loop({ sessionID: chat.id }), llm.wait(3).pipe(Effect.as("repeated" as const))),
      "oversized prompt-specific system text neither terminated nor repeated recovery",
      "5 seconds",
    )

    expect(result).not.toBe("repeated")
    if (result === "repeated") return
    const hits = yield* llm.hits
    const messages = yield* sessions.messages({ sessionID: chat.id })
    const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: result.info.id })
    const ids = messages.map((message) => message.info.id)
    const summaryBody = JSON.stringify(hits[0]?.body)
    const retryBody = JSON.stringify(hits[1]?.body)

    expect(hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
    expect(summaryBody).toContain(oldMarker)
    expect(summaryBody).not.toContain(currentMarker)
    expect(summaryBody).not.toContain(systemMarker)
    expect(retryBody).toContain(summaryMarker)
    expect(retryBody).toContain(currentMarker)
    expect(retryBody).toContain(systemMarker)
    expect(messages.filter((message) => message.info.id === submitted.info.id)).toHaveLength(1)
    expect(
      messages.filter(
        (message) =>
          message.info.role === "user" &&
          message.parts.some((part) => part.type === "text" && part.text === currentMarker),
      ),
    ).toHaveLength(2)
    expect(messages.flatMap((message) => message.parts).filter((part) => part.type === "compaction")).toHaveLength(1)
    expect(messages.filter((message) => message.info.role === "assistant" && message.info.summary)).toHaveLength(1)
    expect(result.info.role).toBe("assistant")
    expect(stored.info.role).toBe("assistant")
    if (result.info.role === "assistant" && stored.info.role === "assistant") {
      expect(result.info.finish).toBe("error")
      expect(result.info.error).toMatchObject({
        name: "ContextOverflowError",
        data: { message: expect.stringContaining("request entity too large") },
      })
      expect(result.info.time.completed).toBeNumber()
      expect(stored.info.finish).toBe(result.info.finish)
      expect(stored.info.error).toEqual(result.info.error)
      expect(stored.info.time.completed).toBe(result.info.time.completed)
    }

    const replay = yield* prompt.loop({ sessionID: chat.id })
    expect(replay.info.id).toBe(result.info.id)
    expect((yield* sessions.messages({ sessionID: chat.id })).map((message) => message.info.id)).toEqual(ids)
    expect(yield* llm.hits).toHaveLength(2)
  }),
)

withOversizedTool.instance("loop excludes disabled tools from preflight payload sizing", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const currentMarker = "disabled-oversized-tool-current-marker"
    const answerMarker = "disabled-oversized-tool-answer-marker"

    yield* seed(chat.id, { finish: "stop" })
    const submitted = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      tools: { [oversizedToolID]: false },
      parts: [{ type: "text", text: currentMarker }],
    })
    yield* llm.textMatch((hit) => {
      const body = JSON.stringify(hit.body)
      return body.includes(currentMarker) && !body.includes(oversizedToolID)
    }, answerMarker)

    const result = yield* awaitWithTimeout(
      Effect.raceFirst(prompt.loop({ sessionID: chat.id }), llm.wait(2).pipe(Effect.as("compacted" as const))),
      "disabled oversized tool neither reached the main request nor repeated compaction",
      "5 seconds",
    )

    expect(result).not.toBe("compacted")
    if (result === "compacted") return
    const hits = yield* llm.hits
    const messages = yield* sessions.messages({ sessionID: chat.id })
    const body = JSON.stringify(hits[0]?.body)

    expect(hits).toHaveLength(1)
    expect(yield* llm.pending).toBe(0)
    expect(body).toContain(currentMarker)
    expect(body).not.toContain(oversizedToolID)
    expect(messages.flatMap((message) => message.parts).filter((part) => part.type === "compaction")).toHaveLength(0)
    expect(messages.some((message) => message.info.role === "assistant" && message.info.summary)).toBe(false)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.parentID).toBe(submitted.info.id)
      expect(result.info.finish).toBe("stop")
      expect(result.info.error).toBeUndefined()
    }
    expect(result.parts).toContainEqual(expect.objectContaining({ type: "text", text: answerMarker }))
  }),
)

withOversizedTool.instance("loop excludes permission-denied tools from preflight payload sizing", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: oversizedToolID, pattern: "*", action: "deny" }],
    })
    const currentMarker = "denied-oversized-tool-current-marker"
    const answerMarker = "denied-oversized-tool-answer-marker"

    yield* seed(chat.id, { finish: "stop" })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: currentMarker }],
    })
    yield* llm.text(answerMarker)

    const result = yield* awaitWithTimeout(
      Effect.raceFirst(prompt.loop({ sessionID: chat.id }), llm.wait(2).pipe(Effect.as("compacted" as const))),
      "permission-denied oversized tool neither reached the main request nor repeated compaction",
      "5 seconds",
    )

    expect(result).not.toBe("compacted")
    if (result === "compacted") return
    const hits = yield* llm.hits
    const messages = yield* sessions.messages({ sessionID: chat.id })
    const body = JSON.stringify(hits[0]?.body)

    expect(hits).toHaveLength(1)
    expect(yield* llm.pending).toBe(0)
    expect(body).toContain(currentMarker)
    expect(body).not.toContain(oversizedToolID)
    expect(messages.flatMap((message) => message.parts).filter((part) => part.type === "compaction")).toHaveLength(0)
    expect(messages.some((message) => message.info.role === "assistant" && message.info.summary)).toBe(false)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.finish).toBe("stop")
      expect(result.info.error).toBeUndefined()
    }
    expect(result.parts).toContainEqual(expect.objectContaining({ type: "text", text: answerMarker }))
  }),
)

withOversizedTool.instance("loop includes enabled tools in preflight payload sizing", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const oldMarker = "enabled-oversized-tool-old-marker"
    const currentMarker = "enabled-oversized-tool-current-marker"
    const summaryMarker = "enabled-oversized-tool-summary-marker"
    const answerMarker = "enabled-oversized-tool-answer-marker"

    yield* seed(chat.id, { finish: "stop", userText: oldMarker })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: currentMarker }],
    })
    yield* llm.text(summaryMarker)
    yield* llm.text(answerMarker)

    const result = yield* awaitWithTimeout(
      Effect.raceFirst(prompt.loop({ sessionID: chat.id }), llm.wait(3).pipe(Effect.as("repeated" as const))),
      "enabled oversized tool neither completed nor repeated compaction",
      "5 seconds",
    )

    expect(result).not.toBe("repeated")
    if (result === "repeated") return
    const hits = yield* llm.hits
    const messages = yield* sessions.messages({ sessionID: chat.id })
    const summaryBody = JSON.stringify(hits[0]?.body)
    const retryBody = JSON.stringify(hits[1]?.body)

    expect(hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
    expect(summaryBody).toContain(oldMarker)
    expect(summaryBody).not.toContain(currentMarker)
    expect(summaryBody).not.toContain(oversizedToolID)
    expect(retryBody).toContain(summaryMarker)
    expect(retryBody).toContain(currentMarker)
    expect(retryBody).toContain(oversizedToolID)
    expect(messages.flatMap((message) => message.parts).filter((part) => part.type === "compaction")).toHaveLength(1)
    expect(messages.filter((message) => message.info.role === "assistant" && message.info.summary)).toHaveLength(1)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.finish).toBe("stop")
      expect(result.info.error).toBeUndefined()
    }
    expect(result.parts).toContainEqual(expect.objectContaining({ type: "text", text: answerMarker }))
  }),
)

it.instance("loop stops provider overflow instead of auto-compacting when disabled", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      compaction: { auto: false },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.error(413, { error: { message: "request entity too large" } })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    const messages = yield* sessions.messages({ sessionID: chat.id })

    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.error?.name).toBe("ContextOverflowError")
      expect(result.info.finish).toBe("error")
    }
    expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(false)
  }),
)

it.instance("loop terminates with overflow when invariant system context cannot fit", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      instructions: ["./oversized.md"],
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const oldMarker = "invariant-system-old-marker"
    const currentMarker = "invariant-system-current-marker"
    const instructionMarker = "invariant-system-instruction-marker"
    const summaryMarker = "invariant-system-summary-marker"
    yield* writeText(path.join(dir, "oversized.md"), `${instructionMarker}\n${"x".repeat(400_000)}`)
    yield* seed(chat.id, { finish: "stop", userText: oldMarker })

    const submitted = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: currentMarker }],
    })
    yield* llm.text(summaryMarker)
    yield* llm.error(413, { error: { message: "request entity too large" } })

    const result = yield* awaitWithTimeout(
      Effect.raceFirst(prompt.loop({ sessionID: chat.id }), llm.wait(3).pipe(Effect.as("repeated" as const))),
      "prompt loop neither terminated nor retried compaction",
      "5 seconds",
    )

    expect(result).not.toBe("repeated")
    if (result === "repeated") return
    const hits = yield* llm.hits
    const messages = yield* sessions.messages({ sessionID: chat.id })
    const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: result.info.id })
    const ids = messages.map((message) => message.info.id)
    const summaryBody = JSON.stringify(hits[0]?.body)
    const retryBody = JSON.stringify(hits[1]?.body)

    expect(hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
    expect(summaryBody).toContain(oldMarker)
    expect(summaryBody).not.toContain(currentMarker)
    expect(summaryBody).not.toContain(instructionMarker)
    expect(retryBody).toContain(summaryMarker)
    expect(retryBody).toContain(currentMarker)
    expect(retryBody).toContain(instructionMarker)
    expect(result.info.role).toBe("assistant")
    expect(stored.info.role).toBe("assistant")
    if (result.info.role === "assistant" && stored.info.role === "assistant") {
      expect(result.info.error?.name).toBe("ContextOverflowError")
      expect(result.info.finish).toBe("error")
      expect(result.info.time.completed).toBeNumber()
      expect(stored.info.error).toEqual(result.info.error)
      expect(stored.info.finish).toBe(result.info.finish)
      expect(stored.info.time.completed).toBe(result.info.time.completed)
    }
    expect(messages.filter((message) => message.info.id === submitted.info.id)).toHaveLength(1)
    const compactions = messages.flatMap((message) => message.parts).filter((part) => part.type === "compaction")
    const summaries = messages.filter((message) => message.info.role === "assistant" && message.info.summary)
    expect(compactions).toHaveLength(1)
    expect(summaries).toHaveLength(1)
    expect(
      summaries.every((message) => "completed" in message.info.time && message.info.time.completed !== undefined),
    ).toBe(true)

    const replay = yield* prompt.loop({ sessionID: chat.id })
    expect(replay.info.id).toBe(result.info.id)
    expect((yield* sessions.messages({ sessionID: chat.id })).map((message) => message.info.id)).toEqual(ids)
    expect(yield* llm.hits).toHaveLength(hits.length)
  }),
)

noLLMServer.instance.skip(
  "prompt emits v2 prompted and synthetic events (v2 projector disabled)",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "hello v2" },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,bm90ZSBjb250ZW50",
          },
        ],
      })

      const messages = yield* SessionV2.Service.use((session) => session.messages({ sessionID: chat.id })).pipe(
        Effect.provide(
          LayerNode.compile(SessionV2.node, [
            [SessionExecution.node, SessionExecution.noopLayer],
            [LocationServiceMap.node, locationServiceMapLayer],
          ]),
        ),
      )
      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, chat.id))
        .get()
        .pipe(Effect.orDie)
      expect(messages.find((message) => message.type === "user")).toMatchObject({ type: "user", text: "hello v2" })
      expect(typeof row?.data.time.created).toBe("number")
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "synthetic", text: expect.stringContaining("Called the Read tool") }),
          expect.objectContaining({ type: "synthetic", text: "note content" }),
        ]),
      )
    }),
  { config: cfg },
)

it.instance("static loop returns assistant text through local provider", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("static loop consumes queued replies across turns", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider turns",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello one" }],
    })

    yield* llm.text("world one")

    const first = yield* prompt.loop({ sessionID: session.id })
    expect(first.info.role).toBe("assistant")
    expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello two" }],
    })

    yield* llm.text("world two")

    const second = yield* prompt.loop({ sessionID: session.id })
    expect(second.info.role).toBe("assistant")
    expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

    expect(yield* llm.hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("loop continues when finish is tool-calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.tool("first", { value: "first" })
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("glob tool keeps instance context during prompt runs", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Glob context",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const file = path.join(dir, "probe.txt")
    yield* writeText(file, "probe")

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "find text files" }],
    })
    yield* llm.tool("glob", { pattern: "**/*.txt" })
    yield* llm.text("done")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")

    const msgs = yield* MessageV2.filterCompactedEffect(session.id)
    const tool = msgs
      .flatMap((msg) => msg.parts)
      .find(
        (part): part is CompletedToolPart =>
          part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
      )
    if (!tool) return

    expect(tool.state.output).toContain(file)
    expect(tool.state.output).not.toContain("No context found for instance")
    expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
  }),
)

it.instance("loop continues when finish is stop but assistant has tool parts", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().tool("first", { value: "first" }).stop())
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("failed subtask preserves metadata on error tool state", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      agent: {
        general: {
          model: "test/missing-model",
        },
      },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.tool("task", {
      description: "inspect bug",
      prompt: "look into the cache key path",
      subagent_type: "general",
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
    expect(taskMsg?.info.role).toBe("assistant")
    if (!taskMsg || taskMsg.info.role !== "assistant") return

    const tool = errorTool(taskMsg.parts)
    if (!tool) return

    expect(tool.state.error).toContain("Tool execution failed")
    expect(tool.state.metadata).toBeDefined()
    expect(tool.state.metadata?.sessionId).toBeDefined()
    expect(tool.state.metadata?.model).toEqual({
      providerID: ProviderV2.ID.make("test"),
      modelID: ModelV2.ID.make("missing-model"),
    })
  }),
)

it.instance("subtask child inherits parent session external_directory allow", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Parent",
      permission: [{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }],
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    yield* prompt.loop({ sessionID: chat.id })

    const kids = yield* sessions.children(chat.id)
    expect(kids).toHaveLength(1)
    const child = kids[0]!
    const rules = child.permission ?? []
    expect(rules).toEqual(
      expect.arrayContaining([{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }]),
    )
    expect(Permission.evaluate("external_directory", "/tmp/allowed/file", rules).action).toBe("allow")
    expect(Permission.evaluate("task", "anything", rules).action).toBe("deny")
  }),
)

noLLMServer.instance("prompt tools replace previous prompt tool rules", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt tools" })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      tools: { bash: false },
      parts: [{ type: "text", text: "first" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      tools: { read: true },
      parts: [{ type: "text", text: "second" }],
    })

    const reloaded = yield* sessions.get(session.id)
    expect(reloaded.permission).toEqual([{ permission: "read", pattern: "*", action: "allow" }])
    expect(Permission.evaluate("bash", "anything", reloaded.permission ?? []).action).toBe("ask")
  }),
)

it.instance(
  "running subtask preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          const tool = taskMsg?.parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running subtask metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBeDefined()
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  5_000,
)

it.instance(
  "running task tool preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant" && item.info.agent === "build")
          const tool = assistant?.parts.find(
            (part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "task",
          )
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running task metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBe("inspect bug")
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  10_000,
)

it.instance(
  "loop sets status to busy then idle",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service

      yield* llm.hang

      const chat = yield* sessions.create({})
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      expect((yield* status.get(chat.id)).type).toBe("busy")
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
      expect((yield* status.get(chat.id)).type).toBe("idle")
    }),
  3_000,
)

// Cancel semantics

it.instance("cancel interrupts loop and resolves with an assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* seed(chat.id)

    yield* llm.hang

    yield* user(chat.id, "more")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)
    yield* prompt.cancel(chat.id)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.info.role).toBe("assistant")
    }
  }),
)

it.instance("cancel records MessageAbortedError on interrupted process", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.hang
    yield* user(chat.id, "hello")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)
    yield* prompt.cancel(chat.id)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const info = exit.value.info
      if (info.role === "assistant") {
        expect(info.error?.name).toBe("MessageAbortedError")
      }
    }
  }),
)

raceNoLLMServer.instance(
  "finalizes assistant when cancelled before processor creation completes",
  () =>
    Effect.gen(function* () {
      processorCreateStarted.length = 0
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          processorCreateStarted.length = 0
        }),
      )

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Processor creation race" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "first" }],
      })

      const firstCreate = defer<void>()
      processorCreateStarted.push(firstCreate.resolve)
      const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => firstCreate.promise)

      yield* prompt.cancel(chat.id)
      const firstExit = yield* Fiber.await(first)
      expect(Exit.isSuccess(firstExit)).toBe(true)

      let messages = yield* sessions.messages({ sessionID: chat.id })
      const firstInterrupted = messages.at(-1)
      expect(firstInterrupted?.info.role).toBe("assistant")
      expect(firstInterrupted?.parts).toHaveLength(0)
      if (firstInterrupted?.info.role === "assistant") {
        expect(firstInterrupted.info.finish).toBeUndefined()
        expect(firstInterrupted.info.time.completed).toBeNumber()
        expect(firstInterrupted.info.error?.name).toBe("MessageAbortedError")
      }

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "second" }],
      })

      const secondCreate = defer<void>()
      processorCreateStarted.push(secondCreate.resolve)
      const second = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => secondCreate.promise)

      yield* prompt.cancel(chat.id)
      const secondExit = yield* Fiber.await(second)
      expect(Exit.isSuccess(secondExit)).toBe(true)

      messages = yield* sessions.messages({ sessionID: chat.id })
      const poisonMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          !message.info.finish &&
          !message.info.time.completed &&
          !message.info.error,
      )
      expect(poisonMessages).toHaveLength(0)

      const interruptedMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          message.info.time.completed &&
          message.info.error?.name === "MessageAbortedError",
      )
      expect(interruptedMessages).toHaveLength(2)

      const lastUser = messages.at(-2)
      const lastAssistant = messages.at(-1)
      expect(lastUser?.info.role).toBe("user")
      expect(lastAssistant?.info.role).toBe("assistant")
      if (lastUser?.info.role === "user" && lastAssistant?.info.role === "assistant") {
        expect(lastAssistant.info.parentID).toBe(lastUser?.info.id)
      }
    }),
  { config: cfg },
  3_000,
)

noLLMServer.instance(
  "cancel finalizes subtask tool state",
  () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const aborted = yield* Deferred.make<void>()
      const registry = yield* ToolRegistry.Service
      const { task } = yield* registry.named()
      const original = task.execute
      task.execute = (_args, ctx) =>
        Effect.callback<never>((_resume) => {
          ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
          if (ctx.abort.aborted) succeedVoid(aborted)
          succeedVoid(ready)
          return Effect.sync(() => succeedVoid(aborted))
        })
      yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = original)))

      const { prompt, chat } = yield* boot()
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for task tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      yield* awaitWithTimeout(Deferred.await(aborted), "timed out waiting for task tool abort", "10 seconds")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return

      const tool = toolPart(taskMsg.parts)
      expect(tool?.type).toBe("tool")
      if (!tool) return

      expect(tool.state.status).not.toBe("running")
      expect(taskMsg.info.time.completed).toBeDefined()
      expect(taskMsg.info.finish).toBeDefined()
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "cancel propagates from slash command subtask to child session",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
      const sessionID = tool?.state.status === "running" ? tool.state.metadata?.sessionId : undefined
      expect(typeof sessionID).toBe("string")
      if (typeof sessionID !== "string") throw new Error("missing child session id")
      const childID = SessionID.make(sessionID)
      expect((yield* status.get(childID)).type).toBe("busy")

      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect((yield* status.get(childID)).type).toBe("idle")
    }),
  10_000,
)

it.instance(
  "cancel with queued callers resolves all cleanly",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)
      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
        expect(exitA.value.info.id).toBe(exitB.value.info.id)
      }
    }),
  { git: true },
  10_000,
)

// Queue semantics

noLLMServer.instance("concurrent loop callers get same result", () =>
  Effect.gen(function* () {
    const { prompt, run, chat } = yield* boot()
    yield* seed(chat.id, { finish: "stop" })

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })

    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
    yield* run.assertNotBusy(chat.id)
  }),
)

it.instance("concurrent loop callers all receive same error result", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.fail("boom")
    yield* user(chat.id, "hello")

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })
    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
  }),
)

it.instance("prompt submitted during an active run is included in the next LLM input", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const gate = yield* Deferred.make<void>()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.hold("first", deferredAsPromise(gate))
    yield* llm.text("second")

    const a = yield* prompt
      .prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "first" }],
      })
      .pipe(Effect.forkChild)

    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const id = MessageID.ascending()
    const b = yield* prompt
      .prompt({
        sessionID: chat.id,
        messageID: id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "second" }],
      })
      .pipe(Effect.forkChild)

    yield* pollWithTimeout(
      sessions
        .messages({ sessionID: chat.id })
        .pipe(
          Effect.map((msgs) => (msgs.some((msg) => msg.info.role === "user" && msg.info.id === id) ? true : undefined)),
        ),
      "timed out waiting for second prompt to save",
    )

    yield* Deferred.succeed(gate, void 0)

    const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
    expect(Exit.isSuccess(ea)).toBe(true)
    expect(Exit.isSuccess(eb)).toBe(true)
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* sessions.messages({ sessionID: chat.id })
    const assistants = msgs.filter((msg) => msg.info.role === "assistant")
    expect(assistants).toHaveLength(2)
    const last = assistants.at(-1)
    if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
    expect(last.info.parentID).toBe(id)
    expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

    const inputs = yield* llm.inputs
    expect(inputs).toHaveLength(2)
    const messages = inputs.at(-1)?.messages
    if (!Array.isArray(messages)) throw new Error("expected LLM messages")
    expect(messages.at(-1)).toEqual({ role: "user", content: "second" })
  }),
)

it.instance("assertNotBusy fails with BusyError when loop running", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service
    yield* llm.hang

    const chat = yield* sessions.create({})
    yield* user(chat.id, "hi")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
    }

    yield* prompt.cancel(chat.id)
    yield* Fiber.await(fiber)
  }),
)

noLLMServer.instance("assertNotBusy succeeds when idle", () =>
  Effect.gen(function* () {
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service

    const chat = yield* sessions.create({})
    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isSuccess(exit)).toBe(true)
  }),
)

// Shell semantics

it.instance("shell rejects with BusyError when loop running", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.hang
    yield* user(chat.id, "hi")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
    }

    yield* prompt.cancel(chat.id)
    yield* Fiber.await(fiber)
  }),
)

unixNoLLMServer(
  "shell captures stdout and stderr in completed tool output",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "printf out && printf err >&2",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("out")
      expect(tool.state.output).toContain("err")
      expect(tool.state.metadata.output).toContain("out")
      expect(tool.state.metadata.output).toContain("err")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell completes a fast command on the preferred shell",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "pwd",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("pwd")
      expect(tool.state.output).toContain(dir)
      expect(tool.state.metadata.output).toContain(dir)
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return

        const { prompt, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "[[ 1 -eq 1 ]] && printf configured",
        })

        const tool = completedTool(result.parts)
        if (!tool) return
        expect(tool.state.output).toContain("configured")
      }),
    ),
  { config: { ...cfg, shell: "bash" } },
  30_000,
)

unixNoLLMServer(
  "shell commands can change directory after startup",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const { prompt, run, chat } = yield* boot()
        const parent = path.dirname(dir)
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "cd .. && pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain(parent)
        expect(tool.state.metadata.output).toContain(parent)
        yield* run.assertNotBusy(chat.id)
      }),
    ),
  { config: cfg },
)

unixNoLLMServer(
  "shell lists files from the project directory",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      yield* writeText(path.join(dir, "README.md"), "# e2e\n")

      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command ls",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("command ls")
      expect(tool.state.output).toContain("README.md")
      expect(tool.state.metadata.output).toContain("README.md")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell captures stderr from a failing command",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("not found")
      expect(tool.state.metadata.output).toContain("not found")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const fiber = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
          .pipe(Effect.forkChild)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
            const taskMsg = msgs.find((item) => item.info.role === "assistant")
            const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
            if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return true
          }),
          "timed out waiting for running shell metadata",
        )

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    ),
  { config: cfg },
  30_000,
)

it.instance(
  "loop waits while shell runs and starts after shell exits",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("after-shell")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const exit = yield* Fiber.await(loop)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
        expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  10_000,
)

it.instance(
  "shell completion resumes queued loop callers",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("done")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

      expect(Exit.isSuccess(ea)).toBe(true)
      expect(Exit.isSuccess(eb)).toBe(true)
      if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
        expect(ea.value.info.id).toBe(eb.value.info.id)
        expect(ea.value.info.role).toBe("assistant")
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  10_000,
)

unix(
  "command ! expansion uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          shell: "bash",
          command: {
            probe: {
              template: "Probe: !`[[ 1 -eq 1 ]] && printf configured`",
            },
          },
        }))

        const { prompt, chat } = yield* boot()
        yield* llm.text("done")

        const result = yield* prompt.command({
          sessionID: chat.id,
          command: "probe",
          arguments: "",
        })

        expect(result.info.role).toBe("assistant")
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("configured")
      }),
    ),
  30_000,
)

unixNoLLMServer(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".shell-ready")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: ": > '.shell-ready'; sleep 30" })
          .pipe(Effect.forkChild)
        yield* pollWithTimeout(
          afs.existsSafe(ready).pipe(Effect.map((exists) => (exists ? (true as const) : undefined))),
          "shell never created readiness marker",
        )

        yield* prompt.cancel(chat.id)

        const status = yield* SessionStatus.Service
        expect((yield* status.get(chat.id)).type).toBe("idle")
        const busy = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(busy)).toBe(true)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".trap-ready")

        const sh = yield* prompt
          .shell({
            sessionID: chat.id,
            agent: "build",
            // Touch marker AFTER trap installs so the test waits for the actual
            // ignore-TERM state before cancelling; otherwise SIGTERM can arrive
            // before `trap` runs and the escalation path is never exercised.
            command: `trap '' TERM; touch "${ready}"; sleep 30`,
          })
          .pipe(Effect.forkChild)

        yield* Effect.gen(function* () {
          while (!(yield* afs.existsSafe(ready))) {
            yield* Effect.sleep(Duration.millis(10))
          }
        }).pipe(Effect.timeout(Duration.seconds(5)))

        yield* prompt.cancel(chat.id)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unix(
  "cancel finalizes interrupted bash tool output through normal truncation",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Interrupted bash truncation",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "run bash" }],
      })

      yield* llm.tool("bash", {
        command:
          'i=0; while [ "$i" -lt 4000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx %05d\\n" "$i"; i=$((i + 1)); done; printf truncation-ready; sleep 30',
        timeout: 30_000,
        workdir: path.resolve(dir),
      })

      const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant")
          const tool = assistant ? toolPart(assistant.parts) : undefined
          if (tool?.state.status === "running" && tool.state.metadata?.output.includes("truncation-ready")) return true
        }),
        "timed out waiting for truncated shell output",
      )
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(run)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isFailure(exit)) return

      const tool = completedTool(exit.value.parts)
      if (!tool) return

      expect(tool.state.metadata.truncated).toBe(true)
      expect(typeof tool.state.metadata.outputPath).toBe("string")
      expect(tool.state.output).toMatch(/\.\.\.output truncated\.\.\./)
      expect(tool.state.output).toMatch(/Full output saved to:\s+\S+/)
      expect(tool.state.output).not.toContain("Tool execution aborted")
    }),
  { git: true },
  30_000,
)

unixNoLLMServer(
  "cancel interrupts loop queued behind shell",
  () =>
    Effect.gen(function* () {
      const { prompt, chat } = yield* boot()

      const sh = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "sleep 30" }).pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(loop)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const tool = completedTool(exit.value.parts)
        expect(tool?.state.output).toContain("User aborted the command")
      }

      yield* Fiber.await(sh)
    }),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const a = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
          .pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(a)
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

// Abort signal propagation tests for inline tool execution

function hangUntilAborted(tool: { execute: (...args: any[]) => any }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const aborted = yield* Deferred.make<void>()
    const original = tool.execute
    tool.execute = (_args: any, ctx: any) => {
      ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
      if (ctx.abort.aborted) succeedVoid(aborted)
      succeedVoid(ready)
      return Effect.callback<never>(() => Effect.sync(() => succeedVoid(aborted)))
    }
    const restore = Effect.addFinalizer(() => Effect.sync(() => void (tool.execute = original)))
    return { ready, aborted, restore }
  })
}

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (text/plain)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const testFile = path.join(dir, "test.txt")
      yield* writeText(testFile, "hello world")

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${testFile}`, filename: "test.txt", mime: "text/plain" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (directory)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${dir}`, filename: "dir", mime: "application/x-directory" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

// Missing file handling

noLLMServer.instance(
  "does not fail the prompt when a file part is missing",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "does-not-exist.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "please review @does-not-exist.ts" },
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "does-not-exist.ts",
          },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")
      const hasFailure = msg.parts.some(
        (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
      )
      expect(hasFailure).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "keeps stored part order stable when file resolution is async",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "still-missing.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "still-missing.ts",
          },
          { type: "text", text: "after-file" },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")

      const stored = yield* MessageV2.get({
        sessionID: session.id,
        messageID: msg.info.id,
      })
      const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

      expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
      expect(text[1]?.includes("Read tool failed to read")).toBe(true)
      expect(text[2]).toBe("after-file")

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

// Special characters in filenames

noLLMServer.instance(
  "handles filenames with # character",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      yield* writeText(path.join(dir, "file#name.txt"), "special content\n")

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const parts = yield* prompt.resolvePromptParts("Read @file#name.txt")
      const fileParts = parts.filter((part) => part.type === "file")

      expect(fileParts.length).toBe(1)
      expect(fileParts[0].filename).toBe("file#name.txt")
      expect(fileParts[0].url).toContain("%23")

      const decodedPath = fileURLToPath(fileParts[0].url)
      expect(decodedPath).toBe(path.join(dir, "file#name.txt"))

      const message = yield* prompt.prompt({
        sessionID: session.id,
        parts,
        noReply: true,
      })
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const textParts = stored.parts.filter((part) => part.type === "text")
      const hasContent = textParts.some((part) => part.text.includes("special content"))
      expect(hasContent).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { git: true, config: cfg },
)

// Regression: empty assistant turn loop

it.instance("does not loop empty assistant turns for a simple reply", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt regression" })

    yield* llm.text("packages/opencode/src/session/processor.ts")

    const result = yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      parts: [{ type: "text", text: "Where is SessionProcessor?" }],
    })

    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("processor.ts"))).toBe(true)

    const msgs = yield* sessions.messages({ sessionID: session.id })
    expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(1)
    expect(yield* llm.calls).toBe(1)
  }),
)

it.instance("records aborted errors when prompt is cancelled mid-stream", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt cancel regression" })

    yield* llm.hang

    const fiber = yield* prompt
      .prompt({
        sessionID: session.id,
        agent: "build",
        parts: [{ type: "text", text: "Cancel me" }],
      })
      .pipe(Effect.forkChild)

    yield* llm.wait(1)
    yield* waitForBusy(session.id)
    yield* prompt.cancel(session.id)

    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.info.role).toBe("assistant")
      if (exit.value.info.role === "assistant") {
        expect(exit.value.info.error?.name).toBe("MessageAbortedError")
      }
    }

    const msgs = yield* sessions.messages({ sessionID: session.id })
    const last = msgs.findLast((msg) => msg.info.role === "assistant")
    expect(last?.info.role).toBe("assistant")
    if (last?.info.role === "assistant") {
      expect(last.info.error?.name).toBe("MessageAbortedError")
    }
  }),
)

// Agent variant

noLLMServer.instance(
  "applies agent variant only when using agent model",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const other = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("opencode"), modelID: ModelV2.ID.make("kimi-k2.5-free") },
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      if (other.info.role !== "user") throw new Error("expected user message")
      expect(other.info.model.variant).toBeUndefined()

      const match = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello again" }],
      })
      if (match.info.role !== "user") throw new Error("expected user message")
      expect(match.info.model).toEqual({
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test-model"),
        variant: "xhigh",
      })
      expect(match.info.model.variant).toBe("xhigh")

      const override = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        variant: "high",
        parts: [{ type: "text", text: "hello third" }],
      })
      if (override.info.role !== "user") throw new Error("expected user message")
      expect(override.info.model.variant).toBe("high")

      yield* sessions.remove(session.id)
    }),
  {
    config: {
      ...cfg,
      provider: {
        ...cfg.provider,
        test: {
          ...cfg.provider.test,
          models: {
            "test-model": {
              ...cfg.provider.test.models["test-model"],
              variants: { xhigh: {}, high: {} },
            },
          },
        },
      },
      agent: {
        build: {
          model: "test/test-model",
          variant: "xhigh",
        },
      },
    },
  },
)

// Agent / command resolution errors

noLLMServer.instance(
  "unknown agent throws typed error",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown agent error includes available agent names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain("build")
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown command throws typed error with available names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .command({
          sessionID: session.id,
          command: "nonexistent-command-xyz",
          arguments: "",
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
          expect(err.data.message).toContain("init")
        }
      }
    }),
  30_000,
)
