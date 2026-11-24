import { describe, expect, test } from "bun:test"
import type { ToolExecutionOptions } from "ai"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool as MCPTool,
} from "@modelcontextprotocol/sdk/types.js"
import { McpCatalog } from "@/mcp/catalog"
import { Effect } from "effect"
import { FastCheck } from "effect/testing"

const options: ToolExecutionOptions = {
  toolCallId: "call_mcp",
  messages: [],
  abortSignal: new AbortController().signal,
}

function clientReturning(result: unknown) {
  return {
    callTool: async () => result,
  } as unknown as Client
}

function mcpTool(): MCPTool {
  return {
    name: "screenshot",
    description: "Take a screenshot",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  }
}

describe("McpCatalog.convertTool", () => {
  test("preserves content when structuredContent is also present", async () => {
    const content = [{ type: "image" as const, mimeType: "image/png", data: "AAAA" }]
    const structuredContent = { image: { mimeType: "image/png", data: "AAAA" } }
    const converted = McpCatalog.convertTool(
      mcpTool(),
      clientReturning({ content, structuredContent }),
      undefined,
      async (text) => text,
    )

    const output = await converted.execute?.({}, options)

    expect(output).toMatchObject({ content, structuredContent })
  })

  test("falls back to structuredContent only when content is absent", async () => {
    const structuredContent = { results: [{ title: "one" }] }
    const converted = McpCatalog.convertTool(
      mcpTool(),
      clientReturning({ content: [], structuredContent }),
      undefined,
      async (text) => text,
    )

    const output = await converted.execute?.({}, options)

    expect(output).toMatchObject({
      structuredContent,
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    })
  })
})

describe("McpCatalog.callToolErrorMessage", () => {
  test("structuredContent-only error carries the JSON", () => {
    const structuredContent = { code: 3007, detail: "quota exceeded" }
    expect(
      McpCatalog.callToolErrorMessage({ isError: true, content: [], structuredContent } as CallToolResult),
    ).toBe(JSON.stringify(structuredContent))
  })

  test("text and structuredContent are joined", () => {
    const structuredContent = { detail: "disk full" }
    expect(
      McpCatalog.callToolErrorMessage({
        isError: true,
        content: [{ type: "text", text: "write failed" }],
        structuredContent,
      } as CallToolResult),
    ).toBe(`write failed\n\n${JSON.stringify(structuredContent)}`)
  })

  test("neither text nor structuredContent keeps the stable fallback", () => {
    expect(McpCatalog.callToolErrorMessage({ isError: true, content: [] } as CallToolResult)).toBe(
      "MCP tool returned an error",
    )
  })

  test("deduplicates semantically equivalent JSON including negative zero", () => {
    const structuredContent = { value: -0, ok: true }
    expect(
      McpCatalog.callToolErrorMessage({
        isError: true,
        content: [{ type: "text", text: '{"ok": true, "value": 0}' }],
        structuredContent,
      } as CallToolResult),
    ).toBe('{"ok": true, "value": 0}')
  })
})

test("preserves output schema validation across paginated tool discovery", async () => {
  const server = new Server({ name: "pagination", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, ({ params }) =>
    Promise.resolve(
      params?.cursor === "page-2"
        ? {
            tools: [
              {
                name: "second",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  properties: { value: { type: "number" } },
                  required: ["value"],
                },
              },
            ],
          }
        : {
            tools: [
              {
                name: "first",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  properties: { value: { type: "string" } },
                  required: ["value"],
                },
              },
            ],
            nextCursor: "page-2",
          },
    ),
  )
  server.setRequestHandler(CallToolRequestSchema, ({ params }) =>
    Promise.resolve({
      content: [],
      structuredContent: { value: params.name === "first" ? 42 : 1 },
    }),
  )

  const client = new Client({ name: "pagination-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

  try {
    const tools = await Effect.runPromise(McpCatalog.defs(client))
    expect(tools?.map((tool) => tool.name)).toEqual(["first", "second"])
    await expect(client.callTool({ name: "first", arguments: {} })).rejects.toThrow(
      "Structured content does not match the tool's output schema",
    )
  } finally {
    await Promise.all([client.close(), server.close()])
  }
})

test("tool failures stay bounded for result and protocol errors over a real MCP transport", async () => {
  const server = new Server({ name: "errors", version: "1" }, { capabilities: { tools: {} } })
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const detail = String(params.arguments?.detail)
    if (params.arguments?.rpc) {
      if (params.arguments?.data) throw new McpError(ErrorCode.InternalError, "protocol error", { detail })
      throw new McpError(ErrorCode.InternalError, detail)
    }
    return { isError: true, content: [], structuredContent: { detail } }
  })
  const client = new Client({ name: "error-test", version: "1" })
  const [peer, transport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(peer), server.connect(transport)])
  try {
    await FastCheck.assert(
      FastCheck.asyncProperty(
        FastCheck.boolean(),
        FastCheck.boolean(),
        FastCheck.string({ minLength: 1, maxLength: 24 }),
        async (rpc, data, word) => {
          const detail = word.repeat(1000)
          const saved: string[] = []
          const tool = McpCatalog.convertTool(mcpTool(), client, undefined, async (text) => {
            saved.push(text)
            return "bounded preview; full output saved"
          })
          await expect(tool.execute?.({ rpc, data, detail }, options)).rejects.toThrow(
            "bounded preview; full output saved",
          )
          expect(saved).toHaveLength(1)
          if (rpc && data) expect(JSON.parse(saved[0]!.split("\n\n").at(-1)!)).toEqual({ detail })
          else if (rpc) expect(saved[0]).toContain(detail)
          else expect(JSON.parse(saved[0]!)).toEqual({ detail })
        },
      ),
      {
        seed: 60413,
        numRuns: 24,
        examples: [
          [true, true, "rpc-data"],
          [true, false, "rpc-message"],
          [false, false, "result"],
        ],
      },
    )
  } finally {
    await Promise.all([client.close(), server.close()])
  }
})

test("cancellation retains the original signal error", async () => {
  const controller = new AbortController()
  const abort = new DOMException("cancelled by caller", "AbortError")
  controller.abort(abort)
  const client = {
    callTool: async () => {
      throw abort
    },
  } as unknown as Client
  let calls = 0
  const tool = McpCatalog.convertTool(mcpTool(), client, undefined, async (text) => {
    calls++
    return text
  })
  await expect(tool.execute?.({}, { ...options, abortSignal: controller.signal })).rejects.toBe(abort)
  expect(calls).toBe(0)
})

test("bounds non-McpError transport failures and omits null McpError data", async () => {
  const saved: string[] = []
  const transportClient = {
    callTool: async () => {
      throw new Error("HTTP 500: " + "z".repeat(10_000))
    },
  } as unknown as Client
  const transportTool = McpCatalog.convertTool(mcpTool(), transportClient, undefined, async (text) => {
    saved.push(text)
    return "bounded transport error"
  })
  await expect(transportTool.execute?.({}, options)).rejects.toThrow("bounded transport error")
  expect(saved).toHaveLength(1)
  expect(saved[0]).toContain("HTTP 500:")

  const nullDataSeen: string[] = []
  const nullDataClient = {
    callTool: async () => {
      throw new McpError(ErrorCode.InternalError, "server failed", null)
    },
  } as unknown as Client
  const nullDataTool = McpCatalog.convertTool(mcpTool(), nullDataClient, undefined, async (text) => {
    nullDataSeen.push(text)
    return text
  })
  await expect(nullDataTool.execute?.({}, options)).rejects.toThrow("server failed")
  expect(nullDataSeen[0]).not.toContain("\n\nnull")
})

test("PBT: all MCP failure kinds (isError, McpError with/without/null data, transport Error) stay bounded", async () => {
  await FastCheck.assert(
    FastCheck.asyncProperty(
      FastCheck.constantFrom(
        "isError" as const,
        "rpcMessage" as const,
        "rpcData" as const,
        "rpcNullData" as const,
        "transportError" as const,
      ),
      FastCheck.string({ minLength: 1, maxLength: 20 }),
      async (kind, word) => {
        const detail = word.repeat(500)
        const saved: string[] = []
        const client = {
          callTool: async () => {
            if (kind === "isError") return { isError: true, content: [], structuredContent: { detail } }
            if (kind === "rpcMessage") throw new McpError(ErrorCode.InternalError, detail)
            if (kind === "rpcData") throw new McpError(ErrorCode.InternalError, "rpc err", { detail })
            if (kind === "rpcNullData") throw new McpError(ErrorCode.InternalError, detail, null)
            throw new Error(`HTTP 500: ${detail}`)
          },
        } as unknown as Client
        const tool = McpCatalog.convertTool(mcpTool(), client, undefined, async (text) => {
          saved.push(text)
          return "bounded-preview"
        })
        await expect(tool.execute?.({}, options)).rejects.toThrow("bounded-preview")
        expect(saved).toHaveLength(1)
        if (kind === "isError") expect(JSON.parse(saved[0]!)).toEqual({ detail })
        else if (kind === "rpcData") expect(JSON.parse(saved[0]!.split("\n\n").at(-1)!)).toEqual({ detail })
        else expect(saved[0]).toContain(detail)
        if (kind === "rpcNullData") expect(saved[0]).not.toContain("\n\nnull")
      },
    ),
    { seed: 600807, numRuns: 100 },
  )
})
