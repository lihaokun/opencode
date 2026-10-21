import fc from "fast-check"
import { describe, expect, it } from "bun:test"

/**
 * §5.3 第三层随机测试（C11 第二组）：grep 分页窗口的纯函数模型。服务层每次
 * 调用都从流头走整个序列、按 match 计数切 [offset, offset+limit) 窗口——
 * 分页靠调用方增大 offset，没有跨调用游标。本测试对任意 match/context 行
 * 序列验证：任意窗口参数下 match 不重不漏、顺序保持；total 与参数无关；
 * hasMore ⇔ 窗口之后还有 match。
 *
 * 模型与 `ripgrep.ts` content 窗口逐行对应：context 行挂起等待归属；match
 * 使 seen+1；seen > offset+limit 时终止（hasMore）；seen > offset 时收下
 * pending + 该 match；流尽且无 hasMore 时收尾 pending。
 */
type Row = { context: boolean; line: number }

const windowPage = (rows: readonly Row[], offset: number, limit: number) => {
  const page: Row[] = []
  let seen = 0
  let hasMore = false
  let pending: Row[] = []
  for (const row of rows) {
    if (row.context) {
      pending.push(row)
      continue
    }
    seen += 1
    if (seen > offset + limit) {
      hasMore = true
      break
    }
    if (seen > offset) page.push(...pending, row)
    pending = []
  }
  if (!hasMore) page.push(...pending)
  return { page, hasMore, total: seen }
}

describe("PBT grep pagination window", () => {
  const rowsArb = fc
    .array(fc.tuple(fc.boolean(), fc.nat(1_000)), { minLength: 0, maxLength: 60 })
    .map((list) => list.map(([context, line], index) => ({ context, line: context ? line : index + 1 })))
  const paramsArb = fc.tuple(fc.nat(12), fc.nat(8).map((n) => n + 1))

  it("any window returns exactly matches[offset..offset+limit), in order", () => {
    fc.assert(
      fc.property(rowsArb, paramsArb, (rows, [offset, limit]) => {
        const matches = rows.filter((row) => !row.context)
        const { page, hasMore } = windowPage(rows, offset, limit)
        const matchRows = page.filter((row) => !row.context)
        expect(matchRows).toStrictEqual(matches.slice(offset, offset + limit))
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
        const matches = rows.filter((row) => !row.context)
        const collected: Row[] = []
        let offset = 0
        // Terminates: offset grows by `limit` per iteration and the walk stops
        // at the first page without hasMore; matches is finite.
        while (true) {
          const { page, hasMore } = windowPage(rows, offset, limit)
          collected.push(...page.filter((row) => !row.context))
          if (!hasMore) break
          offset += limit
        }
        expect(collected).toStrictEqual(matches)
        return true
      }),
      { seed: 0x2_026_10_18, numRuns: 400 },
    )
  })

  it("total is the window end when truncated, else the full match count", () => {
    fc.assert(
      fc.property(rowsArb, paramsArb, (rows, [offset, limit]) => {
        const matches = rows.filter((row) => !row.context)
        const { total, hasMore } = windowPage(rows, offset, limit)
        expect(total).toBe(hasMore ? offset + limit + 1 : matches.length)
        return true
      }),
      { seed: 0x2_026_10_18, numRuns: 400 },
    )
  })

  it("anchors: leading context is held with its match, boundary match keeps one side", () => {
    const rows: Row[] = [
      { context: true, line: 1 },
      { context: false, line: 2 },
      { context: true, line: 3 },
      { context: false, line: 4 },
    ]
    const first = windowPage(rows, 0, 1)
    expect(first.page.map((row) => row.line)).toStrictEqual([1, 2])
    expect(first.hasMore).toBe(true)
    const second = windowPage(rows, 1, 1)
    expect(second.page.map((row) => row.line)).toStrictEqual([3, 4])
  })
})
