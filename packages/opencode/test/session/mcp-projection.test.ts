import { describe, expect, test } from "bun:test"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { projectMcpToolResult } from "../../src/session/tools"

function project(content: unknown[], structuredContent?: unknown) {
  return projectMcpToolResult({ content, structuredContent } as unknown as CallToolResult)
}

describe("session.tools.projectMcpToolResult", () => {
  test("regression: structuredContent is appended when content is non-empty", () => {
    const structuredContent = { matches: [{ path: "src/a.ts", line: 42 }] }
    const out = project([{ type: "text", text: "查询完成" }], structuredContent)
    expect(out.text).toBe(`查询完成\n\n${JSON.stringify(structuredContent)}`)
    expect(out.attachments).toEqual([])
  })

  test("exact echo of the serialized data is not duplicated", () => {
    const structuredContent = { matches: ["one"] }
    const out = project([{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent)
    expect(out.text).toBe(JSON.stringify(structuredContent))
  })

  test("catalog's empty-content conversion stays byte-identical", () => {
    const structuredContent = { results: [{ title: "one" }] }
    const out = project([{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent)
    expect(out.text).toBe(JSON.stringify(structuredContent))
  })

  test("pretty-printed variant of the same data is not duplicated", () => {
    const structuredContent = { matches: ["one"], total: 1 }
    const pretty = JSON.stringify(structuredContent, null, 2)
    const out = project([{ type: "text", text: pretty }], structuredContent)
    expect(out.text).toBe(pretty)
  })

  test("reordered keys of the same data are not duplicated", () => {
    const structuredContent = { a: 1, b: 2 }
    const out = project([{ type: "text", text: JSON.stringify({ b: 2, a: 1 }) }], structuredContent)
    expect(out.text).toBe(JSON.stringify({ b: 2, a: 1 }))
  })

  test("non-JSON prose text does not suppress the append", () => {
    const structuredContent = { hits: 3 }
    const out = project([{ type: "text", text: "查询完成，hits: 3" }], structuredContent)
    expect(out.text).toBe(`查询完成，hits: 3\n\n${JSON.stringify(structuredContent)}`)
  })

  test("absent structuredContent appends nothing", () => {
    expect(project([{ type: "text", text: "only" }], undefined).text).toBe("only")
    expect(project([{ type: "text", text: "only" }], null).text).toBe("only")
  })

  test("resource_link renders as name: uri", () => {
    const out = project([{ type: "resource_link", uri: "file:///tmp/a.txt", name: "a.txt" }])
    expect(out.text).toBe("a.txt: file:///tmp/a.txt")
  })

  test("audio degrades to a placeholder line instead of vanishing", () => {
    const out = project([{ type: "audio", mimeType: "audio/wav", data: "AAAA" }])
    expect(out.text).toBe("[MCP audio content omitted: audio/wav]")
  })
})
