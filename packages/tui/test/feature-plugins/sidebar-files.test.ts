import { describe, expect, test } from "bun:test"
import { FILE_ROWS, fileTotals, fileWindow } from "../../src/feature-plugins/sidebar/files"

const files = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`)

// The sidebar's Modified Files section: one summary line, and when expanded
// a FILE_ROWS window over the list with "↑ N more" / "↓ N more" around it.
describe("fileWindow", () => {
  test("a short list fits in the window with nothing above or below", () => {
    expect(fileWindow(files(3), 0)).toEqual({ top: 0, shown: ["f0", "f1", "f2"], above: 0, below: 0 })
    expect(fileWindow([], 0)).toEqual({ top: 0, shown: [], above: 0, below: 0 })
  })

  test("a long list shows FILE_ROWS rows and counts the rest below", () => {
    expect(FILE_ROWS).toBe(5)
    expect(fileWindow(files(12), 0)).toEqual({ top: 0, shown: ["f0", "f1", "f2", "f3", "f4"], above: 0, below: 7 })
  })

  test("scrolling moves the window and splits the rest above and below", () => {
    expect(fileWindow(files(12), 3)).toEqual({ top: 3, shown: ["f3", "f4", "f5", "f6", "f7"], above: 3, below: 4 })
  })

  test("the window never runs past the end: an offset beyond it, or a list that shrank, clamps to the last page", () => {
    expect(fileWindow(files(12), 40)).toEqual({ top: 7, shown: ["f7", "f8", "f9", "f10", "f11"], above: 7, below: 0 })
    expect(fileWindow(files(4), 9)).toEqual({ top: 0, shown: ["f0", "f1", "f2", "f3"], above: 0, below: 0 })
    expect(fileWindow(files(12), -5).top).toBe(0)
  })

  test("random lists and offsets: the window is full while it can be, and above + shown + below is the whole list", () => {
    let seed = 7
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let i = 0; i < 200; i++) {
      const n = Math.floor(next() * 30)
      const offset = Math.floor(next() * 40) - 5
      const rows = 1 + Math.floor(next() * 8)
      const window = fileWindow(files(n), offset, rows)
      const label = `n=${n} offset=${offset} rows=${rows}`
      expect(window.shown.length, label).toBe(Math.min(n, rows))
      expect(window.above + window.shown.length + window.below, label).toBe(n)
      expect(window.top, label).toBeGreaterThanOrEqual(0)
      expect(window.top, label).toBeLessThanOrEqual(Math.max(0, n - rows))
      expect(window.shown, label).toEqual(files(n).slice(window.top, window.top + rows))
    }
  })
})

describe("fileTotals", () => {
  test("sums additions and deletions over the list", () => {
    expect(
      fileTotals([
        { additions: 10, deletions: 2 },
        { additions: 0, deletions: 7 },
        { additions: 3, deletions: 0 },
      ]),
    ).toEqual({ additions: 13, deletions: 9 })
    expect(fileTotals([])).toEqual({ additions: 0, deletions: 0 })
  })
})
