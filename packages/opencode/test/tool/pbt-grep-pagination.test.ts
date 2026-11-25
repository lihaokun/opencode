import fc from "fast-check"
import { describe, expect, it } from "bun:test"
import { windowContentRows, type ContentStreamRow, type RawRow } from "@opencode-ai/core/ripgrep"

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
const row = (file: string, context: boolean, line: number): RawRow => ({
  path: { text: file },
  line_number: line,
  absolute_offset: line,
  lines: { text: `line-${line}` },
  submatches: [],
  context,
})

describe("PBT grep pagination window (production windowContentRows)", () => {
  // Multi-file stream with strictly increasing line numbers within each file,
  // matching ripgrep's real --sort=path output shape.
  const rowsArb = fc
    .array(
      fc.record({
        file: fc.constantFrom("a.txt", "b.txt", "c.txt"),
        context: fc.boolean(),
        step: fc.integer({ min: 1, max: 3 }),
      }),
      { minLength: 0, maxLength: 60 },
    )
    .map((items) => {
      const sorted = items.toSorted((a, b) => a.file.localeCompare(b.file))
      const lineByFile = new Map<string, number>()
      return sorted.map((item) => {
        const line = (lineByFile.get(item.file) ?? 0) + item.step
        lineByFile.set(item.file, line)
        return row(item.file, item.context, line)
      })
    })
  const paramsArb = fc.tuple(fc.nat(12), fc.nat(8).map((n) => n + 1), fc.nat(2), fc.nat(2))

  it("any window returns exactly matches[offset..offset+limit), in order, with valid context only", () => {
    fc.assert(
      fc.property(rowsArb, paramsArb, (rows, [offset, limit, before, after]) => {
        const matches = rows.filter((r) => !r.context)
        const result = windowContentRows(rows, offset, limit, before, after)
        const expectedMatches = matches.slice(offset, offset + limit)
        const matchKeys = result.rows.filter((r) => !r.context).map((r) => `${r.path}:${r.line}`)
        expect(matchKeys).toStrictEqual(expectedMatches.map((r) => `${r.path.text}:${r.line_number}`))
        expect(result.hasMore).toBe(offset + limit < matches.length)
        // Every admitted context row must belong to the same file as some
        // admitted match and lie within its before/after distance.
        const admittedMatches = result.rows.filter((r) => !r.context)
        for (const entry of result.rows) {
          if (!entry.context) continue
          const anchored = admittedMatches.some(
            (m) =>
              m.path === entry.path &&
              ((entry.line < m.line && m.line - entry.line <= before) ||
                (entry.line > m.line && entry.line - m.line <= after)),
          )
          expect(anchored).toBe(true)
        }
        return true
      }),
      { seed: 0x2_026_10_18, numRuns: 400 },
    )
  })

  it("walking windows by offset yields every match exactly once, order kept", () => {
    fc.assert(
      fc.property(rowsArb, paramsArb, (rows, [, limit, before, after]) => {
        const matches = rows.filter((r) => !r.context)
        const collected: string[] = []
        let offset = 0
        // Terminates: offset grows by `limit` per iteration and the walk stops
        // at the first page without hasMore; matches is finite.
        while (true) {
          const result = windowContentRows(rows, offset, limit, before, after)
          collected.push(...result.rows.filter((r) => !r.context).map((r) => `${r.path}:${r.line}`))
          if (!result.hasMore) break
          offset += limit
        }
        expect(collected).toStrictEqual(matches.map((r) => `${r.path.text}:${r.line_number}`))
        return true
      }),
      { seed: 0x2_026_10_18, numRuns: 400 },
    )
  })

  it("total is the window end when truncated, else the full match count", () => {
    fc.assert(
      fc.property(rowsArb, paramsArb, (rows, [offset, limit, before, after]) => {
        const matches = rows.filter((r) => !r.context)
        const result = windowContentRows(rows, offset, limit, before, after)
        expect(result.total).toBe(result.hasMore ? offset + limit + 1 : matches.length)
        return true
      }),
      { seed: 0x2_026_10_18, numRuns: 400 },
    )
  })

  // R7a 的性质化：offset 越过最后一个 match 的任何窗口，页面必须为空——
  // 不论尾随多少 context 行。纯 context 页是缺陷，不是边界情况。
  it("a window past the last match is empty (no phantom context rows)", () => {
    fc.assert(
      fc.property(rowsArb, paramsArb, (rows, [offset, limit, before, after]) => {
        const matches = rows.filter((r) => !r.context)
        if (offset >= matches.length) {
          const result = windowContentRows(rows, offset, limit, before, after)
          expect(result.rows).toStrictEqual([])
          expect(result.hasMore).toBe(false)
        }
        return true
      }),
      { seed: 0x2_026_10_18, numRuns: 400 },
    )
  })

  it("anchors: leading context is held with its match, boundary match keeps one side", () => {
    const rows = [row("f.txt", true, 1), row("f.txt", false, 2), row("f.txt", true, 3), row("f.txt", false, 4)]
    const first = windowContentRows(rows, 0, 1, 1, 0)
    expect(first.rows.map((r) => r.line)).toStrictEqual([1, 2])
    expect(first.hasMore).toBe(true)
    const second = windowContentRows(rows, 1, 1, 1, 0)
    expect(second.rows.map((r) => r.line)).toStrictEqual([3, 4])
  })

  it("stops consuming the stream immediately once hasMore and trailing after-context or file end are satisfied", () => {
    fc.assert(
      fc.property(
        rowsArb,
        fc.tuple(fc.nat(8), fc.nat(4).map((n) => n + 1), fc.nat(2), fc.nat(3)),
        (rawRows, [offset, limit, before, after]) => {
          // Interleave ripgrep {"type":"end"} markers at file boundaries plus a
          // trailing poison file that must never be touched once hasMore settles.
          const stream: ContentStreamRow[] = []
          for (let i = 0; i < rawRows.length; i++) {
            const current = rawRows[i]!
            stream.push(current)
            if (rawRows[i + 1]?.path.text !== current.path.text) stream.push({ end: true })
          }
          const poisonStart = stream.length
          for (let i = 1; i <= 10; i++) stream.push(row("z-poison.txt", false, i))
          stream.push({ end: true })

          let consumed = 0
          let poisonRead = false
          function* observable(): Generator<ContentStreamRow> {
            for (let i = 0; i < stream.length; i++) {
              consumed++
              if (i >= poisonStart) poisonRead = true
              yield stream[i]!
            }
          }

          const result = windowContentRows(observable(), offset, limit, before, after)
          const origMatches = rawRows.filter((r) => !r.context)
          if (origMatches.length > offset + limit) {
            expect(result.hasMore).toBe(true)
            expect(poisonRead).toBe(false)
            // Compute exact stop index: after seeing the (offset+limit+1)-th match,
            // consumption must halt at or before the last admitted match's `last.line + after`
            // row or its file's `{ end: true }` marker.
            const lastAdmitted = origMatches[offset + limit - 1]!
            const lookahead = origMatches[offset + limit]!
            const lastFileEndIdx = stream.findIndex(
              (item, idx) =>
                "end" in item &&
                idx > 0 &&
                !("end" in stream[idx - 1]!) &&
                (stream[idx - 1] as RawRow).path.text === lastAdmitted.path.text,
            )
            const lookaheadIdx = stream.indexOf(lookahead)
            const maxAllowedIdx =
              lookahead.path.text !== lastAdmitted.path.text
                ? lookaheadIdx
                : Math.min(
                    lastFileEndIdx,
                    stream.findIndex(
                      (item, idx) =>
                        idx >= lookaheadIdx &&
                        ("end" in item ||
                          item.path.text !== lastAdmitted.path.text ||
                          item.line_number >= lastAdmitted.line_number + after),
                    ),
                  )
            expect(consumed - 1).toBeLessThanOrEqual(maxAllowedIdx)
          }
          return true
        },
      ),
      { seed: 600805, numRuns: 400 },
    )
  })
})
