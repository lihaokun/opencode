import { expect } from "bun:test"
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
import { DoomLoop } from "@/session/doom-loop"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "../lib/effect"
import { oracle } from "../lib/doom-loop-oracle"

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

let echoed = 0

const layer = Layer.mergeAll(
  Layer.succeed(Plugin.Service, fakePlugin),
  Layer.succeed(Permission.Service, fakePermission),
  Layer.succeed(MCP.Service, fakeMcp()),
  Layer.succeed(Truncate.Service, fakeTruncate),
  RuntimeFlags.layer(),
  Layer.succeed(
    ToolRegistry.Service,
    ToolRegistry.Service.of({
      ids: () => Effect.succeed(["timing", "echo"]),
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
          {
            id: "echo",
            description: "counts how often it really runs",
            parameters: Schema.Struct({}),
            jsonSchema: { type: "object", properties: {} },
            execute: () =>
              Effect.sync(() => {
                echoed++
                return { title: "echo", metadata: {}, output: "done" }
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

// Fix doc session-fix-step-tail-repeat-and-agents, §4.2: one resolved table is
// one model response. Its third identical call in a row is refused before the
// tool runs; a different call breaks the streak; a doom_loop allow rule opts out.
const REFUSED = "Not run: within this one response, the same tool calls have now been repeated three times in a row."

// Resolves one tool table, runs the echo calls through it in order, and reports
// each call as "ran" or its error text, plus how often echo really ran.
const echoResponse = Effect.fn("test.echoResponse")(function* (doomLoop: "ask" | "allow", values: readonly unknown[]) {
  echoed = 0
  const tools = yield* SessionTools.resolve({
    agent: {
      ...agent,
      permission: [
        { permission: "*", pattern: "*", action: "allow" },
        { permission: "doom_loop", pattern: "*", action: doomLoop },
      ],
    },
    model,
    session: { id: sessionID, permission: [] } as unknown as Session.Info,
    processor: {
      message: { id: messageID } as SessionV1.Assistant,
      updateToolCall: () => Effect.die("unused"),
      completeToolCall: () => Effect.void,
    },
    bypassAgentCheck: false,
    messages: [],
    promptOps: {} as never,
  })
  const execute = tools.echo.execute
  if (!execute) throw new Error("echo tool is missing execute")
  const seen = yield* Effect.forEach(values, (value, index) =>
    Effect.promise(() =>
      Promise.resolve(
        execute({ value }, { toolCallId: `call-${index}`, abortSignal: new AbortController().signal, messages: [] }),
      ).then(
        () => "ran",
        (error: Error) => error.message,
      ),
    ),
  )
  return { seen, echoed }
})

it.effect("refuses the third identical call in a row within one resolved tool table", () =>
  Effect.gen(function* () {
    const values = ["a", "a", "a", "b", "a", "a", "a"]
    expect(yield* echoResponse("ask", values)).toEqual({
      seen: ["ran", "ran", REFUSED, "ran", "ran", "ran", REFUSED],
      echoed: 5,
    })
    expect(yield* echoResponse("allow", values)).toEqual({ seen: values.map(() => "ran"), echoed: 7 })
  }),
)

// P2: random call sequences within one response. A call is refused exactly when
// the calls so far, itself included, end in three equal blocks (§3.1 oracle).
it.effect("refuses exactly where the three-equal-blocks definition holds, on random responses", () =>
  Effect.gen(function* () {
    for (let n = 0; n < 200; n++) {
      const next = rng(4400 + n)
      const values: number[] = []
      const length = 1 + Math.floor(next() * 40)
      while (values.length < length) {
        // Mostly repeat a short random block a few times, sometimes add noise.
        const block = Array.from({ length: 1 + Math.floor(next() * 4) }, () => Math.floor(next() * 3))
        const repeats = next() < 0.7 ? 2 + Math.floor(next() * 3) : 1
        for (let r = 0; r < repeats; r++) values.push(...block)
      }
      const calls = values.slice(0, length)
      const expected = calls.map((_, index) =>
        oracle(
          calls.slice(0, index + 1).map((value) => ({ tool: "echo", input: { value } })),
          DoomLoop.MAX_PERIOD,
        )
          ? REFUSED
          : "ran",
      )
      const actual = yield* echoResponse("ask", calls)
      expect(actual.seen, `seed ${4400 + n}`).toEqual(expected)
      expect(actual.echoed).toBe(expected.filter((item) => item === "ran").length)
    }
  }),
)

function rng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
