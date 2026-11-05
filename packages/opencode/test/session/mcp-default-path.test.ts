import { expect } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"

const sessionID = SessionID.make("ses_mcp_e2e")
const messageID = MessageID.ascending()

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
  updateToolCall: () => Effect.succeed(undefined as SessionV1.ToolPart | undefined),
  completeToolCall: () => Effect.void,
} satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">

const structuredContent = { matches: [{ path: "src/a.ts", line: 42 }] }

const mcpLayer = Layer.effect(
  MCP.Service,
  Effect.gen(function* () {
    const server = new Server({ name: "e2e", version: "1.0.0" }, { capabilities: { tools: {} } })
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: "text", text: "查询完成" }],
      structuredContent,
    }))
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "client", version: "1.0.0" })
    yield* Effect.promise(() => Promise.all([client.connect(clientTransport), server.connect(serverTransport)]))

    return MCP.Service.of({
      tools: () =>
        Effect.succeed({
          lookup: {
            def: { name: "lookup", description: "search", inputSchema: { type: "object", properties: {} } },
            client,
            timeout: 5_000,
          },
        }),
      clients: () => Effect.succeed({ lookup: client }),
    } as Partial<MCP.Interface> as MCP.Interface)
  }),
)

const layer = Layer.mergeAll(
  mcpLayer,
  Layer.succeed(
    ToolRegistry.Service,
    ToolRegistry.Service.of({
      ids: () => Effect.succeed([]),
      all: () => Effect.succeed([]),
      named: () => Effect.die("unused"),
      tools: () => Effect.succeed([]),
    }),
  ),
  Layer.succeed(
    Plugin.Service,
    Plugin.Service.of({
      init: () => Effect.void,
      list: () => Effect.succeed([]),
      trigger: (_name, _input, output) => Effect.succeed(output),
    } satisfies Plugin.Interface),
  ),
  Layer.succeed(
    Permission.Service,
    Permission.Service.of({
      ask: () => Effect.void,
      reply: () => Effect.void,
      list: () => Effect.succeed([]),
    } satisfies Permission.Interface),
  ),
  Layer.succeed(
    Truncate.Service,
    Truncate.Service.of({
      cleanup: () => Effect.void,
      write: () => Effect.succeed("output.txt"),
      output: (text: string) => Effect.succeed({ content: text, truncated: false }),
      limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
    } satisfies Truncate.Interface),
  ),
  RuntimeFlags.layer(),
)

const it = testEffect(layer)

it.effect("default MCP path carries structuredContent from a real server into the tool output", () =>
  Effect.gen(function* () {
    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })

    const execute = tools.lookup.execute
    if (!execute) throw new Error("lookup tool is missing execute")

    const output = (yield* Effect.promise(() =>
      execute(
        {},
        {
          toolCallId: "call_mcp_e2e",
          abortSignal: new AbortController().signal,
          messages: [],
        },
      ),
    )) as { output: string; metadata: { truncated: boolean }; attachments: unknown[] }

    expect(output.output).toBe(`查询完成\n\n${JSON.stringify(structuredContent)}`)
    expect(output.metadata.truncated).toBe(false)
    expect(output.attachments).toEqual([])
  }),
)
