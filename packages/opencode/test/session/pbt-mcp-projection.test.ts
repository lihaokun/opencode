import fc from "fast-check"
import { describe, expect, it } from "bun:test"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { projectMcpToolResult } from "../../src/session/tools"

/**
 * §5.3 第三层随机测试（C11 第四组）：任意 content/structuredContent 组合下，
 * serialized structured data 作为**独立项**在投影文本中恰好出现一次；当某个
 * text 项已是同一数据的等价序列化时为零次（判等去重生效）。
 * 断言按项（\n\n 分割）做全等/语义判等，不做子串计数——短序列化值
 * （"false"、"null"）可以是无关项的子串。
 */
const project = (content: unknown[], structuredContent?: unknown) =>
  projectMcpToolResult({ content, structuredContent } as unknown as CallToolResult)

describe("PBT projectMcpToolResult", () => {
  it("structured data appears exactly once as its own item, or zero times when a text item already carries it", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.string(), fc.constantFrom("absent", "append", "echo"), (value, key, kind) => {
        const structured = { first: value, key }
        const prose = "tool result: " + key
        const echo = JSON.stringify({ key, first: value }, null, 2)
        const texts = kind === "echo" ? [prose, echo] : [prose]
        const output = project(
          texts.map((text) => ({ type: "text", text })),
          kind === "absent" ? undefined : structured,
        )
        const expected = kind === "append" ? [...texts, JSON.stringify(structured)] : texts
        expect(output.text).toBe(expected.join("\n\n"))
      }),
      { seed: 0x2_026_10_18, numRuns: 200 },
    )
  })

  // Anchor: the two regimes the property distinguishes, on concrete values.
  it("anchors: plain append and exact-echo suppression", () => {
    const structured = { a: 1 }
    expect(project([{ type: "text", text: "prose" }], structured).text).toBe(`prose\n\n${JSON.stringify(structured)}`)
    expect(project([{ type: "text", text: `{"a":1}` }], structured).text).toBe(`{"a":1}`)
  })
})
