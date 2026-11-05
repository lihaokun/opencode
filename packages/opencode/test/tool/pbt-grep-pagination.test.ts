import fc from "fast-check"
import { describe, expect, it } from "bun:test"
import { windowContentRows, type RawRow } from "@opencode-ai/core/ripgrep"

/**
 * §5.3 第三层随机测试（C11 第二组 + reviewer 二轮 III.1）：grep 分页窗口。
 * 与初版不同，这里直接测**生产实现** `Ripgrep.windowContentRows`（ripgrep.ts
 * 导出的纯函数），不再复制一份窗口逻辑——复制品测不出实现的回归。oracle
 * 只用独立重算的 match 序列，断言：任意窗口参数下 match 不重不漏、顺序保
 * 持；hasMore ⇔ 窗口之后还有 match；offset 越过全部 match 时页面为空（纯
 * context 的尾行不得当作结果行浮出，R7a）。
 *
 * 跨调用的顺序稳定性（R2）不在此层：那是 rg 遍历顺序的性质，由
 * grep.test.ts 的「pagination across invocations」用真实目录树覆盖。
 */
const row = (context: boolean, line: number): RawRow => ({
  path: { text: "f.txt" },
  line_number: line,
  absolute_offset: line,
  lines: { text: `line-${line}` },
  submatches: [],
  context,
})

describe("PBT grep pagination window (production windowContentRows)", () => {
  const rowsArb = fc
    .array(fc.tuple(fc.boolean(), fc.nat(1_000)), { minLength: 0, maxLength: 60 })
    .map((list) => list.map(([context, line], index) => row(context, context ? line : index + 1)))
  const paramsArb = fc.tuple(fc.nat(12), fc.nat(8).map((n) => n + 1))

  it("any window returns exactly matches[offset..offset+limit), in order", () => {
    fc.assert(
      fc.property(rowsArb, paramsArb, (rows, [offset, limit]) => {
        const matches = rows.filter((r) => !r.context)
        const { rows: page, hasMore } = windowContentRows(rows, offset, limit)
        const matchLines = page.filter((r) => !r.context).map((r) => r.line)
        expect(matchLines).toStrictEqual(matches.slice(offset, offset + limit).map((r) => r.line_number))
        // No match is lost across the boundary: hasMore iff matches remain.
        expect(hasMore).toBe(offset + limit < matches.length)
        return true
      }),
      { seed: 0x2_026_10_18, numRuns: 400 },
    )
  })

  it("walking windows by offset yields every match exactly once, order kept", () => {
    fc.assert(
      fc.property(rowsArb, paramsArb, (rows, [, limit]) => {
        const matches = rows.filter((r) => !r.context)
        const collected: number[] = []
        let offset = 0
        // Terminates: offset grows by `limit` per iteration and the walk stops
        // at the first page without hasMore; matches is finite.
        while (true) {
          const { rows: page, hasMore } = windowContentRows(rows, offset, limit)
          collected.push(...page.filter((r) => !r.context).map((r) => r.line))
          if (!hasMore) break
          offset += limit
        }
        expect(collected).toStrictEqual(matches.map((r) => r.line_number))
        return true
      }),
      { seed: 0x2_026_10_18, numRuns: 400 },
    )
  })

  it("total is the window end when truncated, else the full match count", () => {
    fc.assert(
      fc.property(rowsArb, paramsArb, (rows, [offset, limit]) => {
        const matches = rows.filter((r) => !r.context)
        const { total, hasMore } = windowContentRows(rows, offset, limit)
        expect(total).toBe(hasMore ? offset + limit + 1 : matches.length)
        return true
      }),
      { seed: 0x2_026_10_18, numRuns: 400 },
    )
  })

  // R7a 的性质化：offset 越过最后一个 match 的任何窗口，页面必须为空——
  // 不论尾随多少 context 行。纯 context 页是缺陷，不是边界情况。
  it("a window past the last match is empty (no phantom context rows)", () => {
    fc.assert(
      fc.property(rowsArb, paramsArb, (rows, [offset, limit]) => {
        const matches = rows.filter((r) => !r.context)
        if (offset >= matches.length) {
          const { rows: page, hasMore } = windowContentRows(rows, offset, limit)
          expect(page).toStrictEqual([])
          expect(hasMore).toBe(false)
        }
        return true
      }),
      { seed: 0x2_026_10_18, numRuns: 400 },
    )
  })

  it("anchors: leading context is held with its match, boundary match keeps one side", () => {
    const rows = [row(true, 1), row(false, 2), row(true, 3), row(false, 4)]
    const first = windowContentRows(rows, 0, 1)
    expect(first.rows.map((r) => r.line)).toStrictEqual([1, 2])
    expect(first.hasMore).toBe(true)
    const second = windowContentRows(rows, 1, 1)
    expect(second.rows.map((r) => r.line)).toStrictEqual([3, 4])
  })
})
