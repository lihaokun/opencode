import { describe, expect } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "../lib/effect"

const callID = "call-test"
const sessionID = SessionID.make("ses_test")
const messageID = MessageID.ascending()
const partID = PartID.ascending()

const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}

const model = {
  providerID: ProviderV2.ID.make("test"),
  api: { id: "test-model" },
} as Provider.Model

function fakeMcp() {
  return MCP.Service.of({
    tools: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
  } as Partial<MCP.Interface> as MCP.Interface)
}

const fakePlugin = Plugin.Service.of({
  init: () => Effect.void,
  list: () => Effect.succeed([]),
  trigger: (_name, _input, output) => Effect.succeed(output),
} satisfies Plugin.Interface)

const fakePermission = Permission.Service.of({
  ask: () => Effect.void,
  reply: () => Effect.void,
  list: () => Effect.succeed([]),
} satisfies Permission.Interface)

const fakeTruncate = Truncate.Service.of({
  cleanup: () => Effect.void,
  write: () => Effect.succeed("output.txt"),
  output: (text: string) => Effect.succeed({ content: text, truncated: false }),
  limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
} satisfies Truncate.Interface)

const fakeAgent = Agent.Service.of({
  get: () => Effect.succeed(agent),
  list: () => Effect.succeed([agent]),
  defaultInfo: () => Effect.succeed(agent),
  defaultAgent: () => Effect.succeed(agent.name),
} as Partial<Agent.Interface> as Agent.Interface)

const layer = Layer.mergeAll(
  Layer.succeed(Plugin.Service, fakePlugin),
  Layer.succeed(Permission.Service, fakePermission),
  Layer.succeed(MCP.Service, fakeMcp()),
  Layer.succeed(Truncate.Service, fakeTruncate),
  Layer.succeed(Agent.Service, fakeAgent),
  RuntimeFlags.layer(),
  Layer.succeed(
    ToolRegistry.Service,
    ToolRegistry.Service.of({
      ids: () => Effect.succeed(["timing"]),
      all: () => Effect.succeed([]),
      named: () => Effect.die("unused"),
      tools: () =>
        Effect.succeed([
          {
            id: "timing",
            description: "updates metadata more than once",
            parameters: Schema.Struct({}),
            jsonSchema: { type: "object", properties: {} },
            execute: (_args, ctx) =>
              Effect.gen(function* () {
                yield* ctx.metadata({ metadata: { output: "first" } })
                yield* ctx.metadata({ metadata: { output: "second" } })
                return { title: "timing", metadata: {}, output: "done" }
              }),
          } satisfies Tool.Def,
        ]),
    }),
  ),
)

const it = testEffect(layer)

it.effect("preserves running tool start time across metadata updates", () =>
  Effect.gen(function* () {
    const state: SessionV1.ToolPart = {
      id: partID,
      sessionID,
      messageID,
      type: "tool",
      tool: "timing",
      callID,
      state: {
        status: "running",
        input: {},
        time: { start: 100 },
      },
    }
    const updates: number[] = []
    const processor = {
      message: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      } satisfies SessionV1.Assistant,
      updateToolCall: (_toolCallID, update) =>
        Effect.sync(() => {
          const next = update(state)
          state.state = next.state
          if (state.state.status === "running") updates.push(state.state.time.start)
          return state
        }),
      completeToolCall: () => Effect.void,
    } satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">

    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    const execute = tools.timing.execute
    if (!execute) throw new Error("timing tool is missing execute")

    yield* Effect.promise(() =>
      execute(
        {},
        {
          toolCallId: callID,
          abortSignal: new AbortController().signal,
          messages: [],
        },
      ),
    )

    expect(updates).toEqual([100, 100])
    expect(state.state.status).toBe("running")
    if (state.state.status === "running") {
      expect(state.state.time.start).toBe(100)
    }
  }),
)

describe("tool.execute.before updatedInput", () => {
  function recordingPlugin(hooks: Record<string, (input: any, output: any) => Promise<void>>) {
    return Plugin.Service.of({
      init: () => Effect.void,
      list: () => Effect.succeed([]),
      trigger: (name, input, output) =>
        Effect.promise(async () => {
          const hook = hooks[name as string]
          if (hook) await hook(input, output)
          return output
        }),
    } satisfies Plugin.Interface)
  }

  // The resolve-level fake registry stays in place; each test swaps in its own
  // recording tool through a ToolRegistry layer override.
  function recordingRegistry(record: (args: any, ctx: Tool.Context) => void) {
    return Layer.succeed(
      ToolRegistry.Service,
      ToolRegistry.Service.of({
        ids: () => Effect.succeed(["timing"]),
        all: () => Effect.succeed([]),
        named: () => Effect.die("unused"),
        tools: () =>
          Effect.succeed([
            {
              id: "timing",
              description: "records executed vs visible input",
              parameters: Schema.Struct({}),
              jsonSchema: { type: "object", properties: {} },
              execute: (args: any, ctx: Tool.Context) =>
                Effect.sync(() => {
                  record(args, ctx)
                  return { title: "timing", metadata: {}, output: "done" }
                }),
            } satisfies Tool.Def,
          ]),
      }),
    )
  }

  function makeProcessor(recorder: { inputs: unknown[] }) {
    const state: SessionV1.ToolPart = {
      id: partID,
      sessionID,
      messageID,
      type: "tool",
      tool: "timing",
      callID,
      state: {
        status: "running",
        input: {},
        time: { start: 100 },
      },
    }
    return {
      state,
      handle: {
        message: {
          id: messageID,
          sessionID,
          role: "assistant",
          parentID: MessageID.ascending(),
          agent: "build",
          mode: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelV2.ID.make("test-model"),
          providerID: ProviderV2.ID.make("test"),
          time: { created: 1 },
        } satisfies SessionV1.Assistant,
        updateToolCall: (_toolCallID, update) =>
          Effect.sync(() => {
            const next = update(state)
            state.state = next.state
            if (state.state.status === "running") recorder.inputs.push(state.state.input)
            return state
          }),
        completeToolCall: () => Effect.void,
      } satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">,
    }
  }

  const resolveWith = (pluginService: Plugin.Interface) =>
    SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor: makeProcessor({ inputs: [] }).handle,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    }).pipe(Effect.provideService(Plugin.Service, pluginService))

  const runTiming = async (tools: Record<string, { execute?: any }>, args: Record<string, unknown>) => {
    const execute = tools.timing.execute
    if (!execute) throw new Error("timing tool is missing execute")
    return execute(args, {
      toolCallId: callID,
      abortSignal: new AbortController().signal,
      messages: [],
    })
  }

  it.effect("updatedInput replaces the executed args while visible input keeps the original", () =>
    Effect.gen(function* () {
      const seen: { executed: unknown; visible: unknown } = { executed: undefined, visible: undefined }
      const recorder = { inputs: [] as unknown[] }
      const plugin = recordingPlugin({
        "tool.execute.before": async (_input, output) => {
          output.updatedInput = { command: "wrapped -- real" }
        },
      })
      const proc = makeProcessor(recorder)
      const tools = yield* SessionTools.resolve({
        agent,
        model,
        session: { id: sessionID, permission: [] } as unknown as Session.Info,
        processor: proc.handle,
        bypassAgentCheck: false,
        messages: [],
        promptOps: {} as never,
      }).pipe(
        Effect.provideService(Plugin.Service, plugin),
        Effect.provide(
          recordingRegistry((args, ctx) => {
            seen.executed = args
            seen.visible = ctx.visibleInput
          }),
        ),
      )

      yield* Effect.promise(() => runTiming(tools as any, { command: "original -- model" }))

      expect(seen.executed).toEqual({ command: "wrapped -- real" })
      expect(seen.visible).toEqual({ command: "original -- model" })
      // metadata write-backs re-record the model-visible input, not the rewrite
      for (const input of recorder.inputs) {
        expect(input).toEqual({ command: "original -- model" })
      }
    }),
  )

  it.effect("tool.execute.after sees the original args, not the rewrite", () =>
    Effect.gen(function* () {
      const afters: unknown[] = []
      const plugin = recordingPlugin({
        "tool.execute.before": async (_input, output) => {
          output.updatedInput = { command: "wrapped -- real" }
        },
        "tool.execute.after": async (input, _output) => {
          afters.push((input as any).args)
        },
      })
      const tools = yield* resolveWith(plugin)
      yield* Effect.promise(() => runTiming(tools as any, { command: "original -- model" }))
      expect(afters).toEqual([{ command: "original -- model" }])
    }),
  )

  it.effect("last hook to set updatedInput wins", () =>
    Effect.gen(function* () {
      const seen: { executed: unknown } = { executed: undefined }
      // two hooks on the same output object, in registration order — the
      // second (last) one overwrites the field, mirroring the in-place
      // mutation order semantics of Plugin.trigger
      const pluginA = Plugin.Service.of({
        init: () => Effect.void,
        list: () => Effect.succeed([]),
        trigger: (name, _input, output) =>
          Effect.sync(() => {
            if (name === "tool.execute.before") (output as any).updatedInput = { command: "first" }
            return output
          }),
      } satisfies Plugin.Interface)
      const pluginB = Plugin.Service.of({
        init: () => Effect.void,
        list: () => Effect.succeed([]),
        trigger: (name, _input, output) =>
          Effect.sync(() => {
            if (name === "tool.execute.before") (output as any).updatedInput = { command: "second" }
            return output
          }),
      } satisfies Plugin.Interface)
      const both = Plugin.Service.of({
        init: () => Effect.void,
        list: () => Effect.succeed([]),
        trigger: (name, input, output) =>
          Effect.gen(function* () {
            yield* pluginA.trigger(name as never, input as never, output as never)
            yield* pluginB.trigger(name as never, input as never, output as never)
            return output
          }),
      } satisfies Plugin.Interface)
      const tools = yield* SessionTools.resolve({
        agent,
        model,
        session: { id: sessionID, permission: [] } as unknown as Session.Info,
        processor: makeProcessor({ inputs: [] }).handle,
        bypassAgentCheck: false,
        messages: [],
        promptOps: {} as never,
      }).pipe(
        Effect.provideService(Plugin.Service, both),
        Effect.provide(
          recordingRegistry((args) => {
            seen.executed = args
          }),
        ),
      )
      yield* Effect.promise(() => runTiming(tools as any, { command: "original -- model" }))
      expect(seen.executed).toEqual({ command: "second" })
    }),
  )

  it.effect("without updatedInput the executed args are the (possibly mutated) hook args", () =>
    Effect.gen(function* () {
      const seen: { executed: unknown; visible: unknown } = { executed: undefined, visible: undefined }
      const plugin = recordingPlugin({
        "tool.execute.before": async (_input, output) => {
          // legacy in-place mutation: same object, field rewritten
          output.args.command = "mutated -- legacy"
        },
      })
      const tools = yield* SessionTools.resolve({
        agent,
        model,
        session: { id: sessionID, permission: [] } as unknown as Session.Info,
        processor: makeProcessor({ inputs: [] }).handle,
        bypassAgentCheck: false,
        messages: [],
        promptOps: {} as never,
      }).pipe(
        Effect.provideService(Plugin.Service, plugin),
        Effect.provide(
          recordingRegistry((args, ctx) => {
            seen.executed = args
            seen.visible = ctx.visibleInput
          }),
        ),
      )
      const args = { command: "original -- model" }
      yield* Effect.promise(() => runTiming(tools as any, args))
      // legacy mode keeps behaving exactly as before this subplan: the mutation
      // flows to execution AND the visible layer (shared reference)
      expect(seen.executed).toEqual({ command: "mutated -- legacy" })
      expect(seen.visible).toBe(seen.executed)
    }),
  )

  it.effect("updatedInput that fails the tool schema surfaces InvalidArgumentsError and skips the tool body", () =>
    Effect.gen(function* () {
      let calls = 0
      const plugin = recordingPlugin({
        "tool.execute.before": async (_input, output) => {
          // violates the tool's declared parameters (count must be a number)
          output.updatedInput = { count: "not-a-number" }
        },
      })
      // A real (wrapped) tool: Tool.define applies the schema decode in the
      // wrap, which is the same validation every built-in/plugin registry tool
      // goes through — exactly what a hook-supplied updatedInput must pass.
      const info = yield* Tool.define(
        "typed",
        Effect.succeed({
          description: "typed parameters reject strings",
          parameters: Schema.Struct({ count: Schema.Number }),
          execute: () =>
            Effect.sync(() => {
              calls++
              return { title: "typed", metadata: {}, output: "done" }
            }),
        }),
      ).pipe(Effect.provideService(Truncate.Service, fakeTruncate), Effect.provideService(Agent.Service, fakeAgent))
      const def = { ...((yield* info.init()) as unknown as Tool.Def), id: "typed" }
      const registry = Layer.succeed(
        ToolRegistry.Service,
        ToolRegistry.Service.of({
          ids: () => Effect.succeed(["typed"]),
          all: () => Effect.succeed([def]),
          named: () => Effect.die("unused"),
          tools: () => Effect.succeed([def]),
        }),
      )
      const tools = yield* SessionTools.resolve({
        agent,
        model,
        session: { id: sessionID, permission: [] } as unknown as Session.Info,
        processor: makeProcessor({ inputs: [] }).handle,
        bypassAgentCheck: false,
        messages: [],
        promptOps: {} as never,
      }).pipe(Effect.provideService(Plugin.Service, plugin), Effect.provide(registry))
      const aiExecute = tools.typed.execute
      if (!aiExecute) throw new Error("typed tool is missing execute")
      // SessionTools.execute returns a plain promise (run.promise); the wrap's
      // orDie turns the decode failure into a thrown InvalidArgumentsError.
      let thrown: unknown
      const outcome = yield* Effect.promise(() =>
        aiExecute(
          { count: 1 },
          {
            toolCallId: callID,
            abortSignal: new AbortController().signal,
            messages: [],
          },
        ).then(
          () => "ok" as const,
          (error: unknown) => {
            thrown = error
            return "thrown" as const
          },
        ),
      )
      expect(outcome).toBe("thrown")
      expect(thrown).toBeInstanceOf(Tool.InvalidArgumentsError)
      expect((thrown as Tool.InvalidArgumentsError).message).toContain("typed tool was called with invalid arguments")
      // the tool body never ran
      expect(calls).toBe(0)
    }),
  )
})
