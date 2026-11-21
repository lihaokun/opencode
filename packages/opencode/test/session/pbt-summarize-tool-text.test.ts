import fc from "fast-check"
import { describe, expect, it } from "bun:test"
import {
  TOOL_RESULT_SUMMARY_MAX_CHARS,
  summarizeToolText,
  summarizeToolError,
} from "@opencode-ai/core/session/tool-result-projection"

// Tail size is module-private; derive it from the output shape. The output is
// head + "\n[... N chars truncated ...]\n" + tail, so the tail is everything
// after the last "\n".
const tailChars = (() => {
  const out = summarizeToolText("x".repeat(TOOL_RESULT_SUMMARY_MAX_CHARS + 5))
  return out.length - out.lastIndexOf("\n") - 1
})()

/**
 * §5.3 第三层随机测试（workflow §6.2 Step 0 C11）：summarizeToolText 的三条
 * 性质——任意输入结果长度有界；预算内恒等；超预算时保留原文的头和尾。
 * 固定 seed（失败可复现）；fast-check 报错自带 shrinking counterexample。
 */
describe("PBT summarizeToolText", () => {
  const textArb = fc.string({ minLength: 0, maxLength: 5_000, unit: "binary-ascii" })
  const check = (prop: fc.IProperty<unknown>, seed = 0x2_026_10_18) =>
    fc.assert(prop, { seed, numRuns: 300 })

  it("output length is bounded for any input", () => {
    check(
      fc.property(textArb, (text) => {
        const out = summarizeToolText(text)
        // ≤ MAX passes through byte-identical; over MAX it is head + marker + tail.
        return out.length <= TOOL_RESULT_SUMMARY_MAX_CHARS + 80
      }),
    )
  })

  it("within budget the text passes through byte-identical", () => {
    check(
      fc.property(textArb, (text) => {
        fc.pre(text.length <= TOOL_RESULT_SUMMARY_MAX_CHARS)
        return summarizeToolText(text) === text
      }),
    )
  })

  it("over budget the result keeps the original head and tail", () => {
    // Generate directly above the cap: maxLength 8k against a 2k cap keeps the
    // "over budget" filter almost always true instead of rejecting 30001/30000.
    const overBudgetArb = fc
      .string({ minLength: TOOL_RESULT_SUMMARY_MAX_CHARS + 1, maxLength: 8_000, unit: "binary-ascii" })
    check(
      fc.property(overBudgetArb, (text) => {
        const out = summarizeToolText(text)
        const head = text.slice(0, TOOL_RESULT_SUMMARY_MAX_CHARS - tailChars)
        const tail = text.slice(-tailChars)
        return out.startsWith(head) && out.endsWith(tail) && out.includes("chars truncated")
      }),
    )
  })

  it("preserves Unicode scalars and reports the number of omitted UTF-16 units", () => {
    const supplementary = fc.integer({ min: 0x10000, max: 0x10ffff }).map((cp) => String.fromCodePoint(cp))
    fc.assert(
      fc.property(supplementary, supplementary, fc.integer({ min: 1, max: 2_000 }), (left, right, middle) => {
        const text = "h".repeat(1_399) + left + "m".repeat(middle) + right + "t".repeat(599)
        const out = summarizeToolText(text)
        expect(out.isWellFormed()).toBe(true)
        const parts = /^(.*?)\n\[\.\.\. (\d+) chars truncated \.\.\.\]\n(.*?)$/s.exec(out)
        expect(parts).not.toBeNull()
        if (!parts) return
        expect(text.startsWith(parts[1])).toBe(true)
        expect(text.endsWith(parts[3])).toBe(true)
        expect(+parts[2]).toBe(text.length - parts[1].length - parts[3].length)
        expect(out.length).toBeLessThanOrEqual(TOOL_RESULT_SUMMARY_MAX_CHARS + 80)
      }),
      { seed: 4619, numRuns: 100 },
    )
  })

  // Plain sanity anchor so a broken import fails loudly rather than as three
  // vacuous pre-condition skips.
  it("anchors: short input identity and long input shape", () => {
    expect(summarizeToolText("hello")).toBe("hello")
    const long = "a".repeat(TOOL_RESULT_SUMMARY_MAX_CHARS + 10)
    expect(summarizeToolText(long)).toContain("chars truncated")
  })
})

it("keeps the full error artifact path even if the path exceeds the text tail", () => {
  const path = "/tmp/" + "long-path/".repeat(100) + "tool-result"
  const error =
    "lookup failed\n" +
    "x".repeat(4000) +
    "\nThe tool call failed; error output was truncated. Full output saved to: " +
    path +
    "\nUse Grep to search the full content or Read with offset/limit to view specific sections."
  const preview = summarizeToolError(error)
  expect(preview).toContain("lookup failed")
  expect(preview).toContain(path)
  expect(preview.length).toBeLessThan(error.length)
})
