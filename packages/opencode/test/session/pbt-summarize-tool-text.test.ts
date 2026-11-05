import fc from "fast-check"
import { describe, expect, it } from "bun:test"
import {
  TOOL_RESULT_SUMMARY_MAX_CHARS,
  summarizeToolText,
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
        const bound = Math.max(text.length, TOOL_RESULT_SUMMARY_MAX_CHARS + 80)
        return out.length <= bound
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

  // Plain sanity anchor so a broken import fails loudly rather than as three
  // vacuous pre-condition skips.
  it("anchors: short input identity and long input shape", () => {
    expect(summarizeToolText("hello")).toBe("hello")
    const long = "a".repeat(TOOL_RESULT_SUMMARY_MAX_CHARS + 10)
    expect(summarizeToolText(long)).toContain("chars truncated")
  })
})
