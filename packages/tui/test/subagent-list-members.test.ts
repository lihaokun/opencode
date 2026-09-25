import { describe, expect, test } from "bun:test"
import { Locale } from "../src/util/locale"
import {
  formatAgentRow,
  formatListElapsed,
  formatListTokens,
  subagentDescription,
  subagentListMembers,
  treeRoot,
} from "../src/routes/session/index"

const info = (over: Record<string, unknown> = {}) => ({
  agent: "explore",
  title: "反方辩手立论 (@general subagent)",
  metadata: { agentName: "alpha" },
  tokens: { input: 900, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1000, updated: 21_000 },
  ...over,
})

// INV-4 (revised per verification finding P1): the list is the tree's full
// membership — root, every subagent, and the session being viewed. One list,
// one navigation surface; where the viewer sits is conveyed by the current
// marker in the dialog, not by omitting rows. Direct children sort first,
// then by creation time; grandchildren indent beneath their elders.
const session = (id: string, parentID?: string, created = 0) => ({
  id,
  parentID,
  time: { created },
})

describe("subagentListMembers", () => {
  const tree = [
    session("root", undefined, 1),
    session("a", "root", 2),
    session("b", "root", 3),
    session("g", "a", 4), // grandchild
  ]

  test("lists the whole tree: root first, then children, then the grandchild", () => {
    expect(subagentListMembers(tree, "root")).toEqual([
      { id: "root", depth: 0 },
      { id: "a", depth: 1 },
      { id: "b", depth: 1 },
      { id: "g", depth: 2 },
    ])
  })

  test("sorts siblings of equal depth by creation time", () => {
    const byTime = [session("root"), session("late", "root", 10), session("early", "root", 5)]
    expect(subagentListMembers(byTime, "root").map((m) => m.id)).toEqual(["root", "early", "late"])
  })

  test("is view-independent: the builder takes only the root, so every seat lists the same rows", () => {
    const fromRoot = subagentListMembers(tree, "root")
    expect(subagentListMembers(tree, "root")).toEqual(fromRoot)
    expect(fromRoot.map((m) => m.id)).toContain("root")
    expect(fromRoot.map((m) => m.id)).toContain("g")
  })

  test("a bare session lists just itself at depth 0 (Main row)", () => {
    expect(subagentListMembers([session("root")], "root")).toEqual([{ id: "root", depth: 0 }])
    expect(subagentListMembers([], "root")).toEqual([{ id: "root", depth: 0 }])
  })
})

// P1 regression: from a grandchild, `parentID ?? id` yields the middle node —
// the list shrank to "current + parent" with "Main" pinned on the parent.
describe("treeRoot", () => {
  const tree = [
    session("root"),
    session("mid", "root"),
    session("leaf", "mid"),
  ]

  test("resolves the true root from every seat in the tree", () => {
    for (const seat of ["root", "mid", "leaf"]) {
      expect(treeRoot(tree, seat)).toBe("root")
    }
  })

  test("falls back to the seat itself when the chain is missing from the projection", () => {
    expect(treeRoot([session("leaf", "gone")], "leaf")).toBe("leaf")
  })

  test("an unknown seat resolves to itself", () => {
    expect(treeRoot([], "ses_elsewhere")).toBe("ses_elsewhere")
  })
})

// Verification finding P3: row blurb and right-hand meters.
describe("subagentDescription", () => {
  test("strips the @type subagent suffix from the session title", () => {
    expect(subagentDescription("反方辩手立论 (@general subagent)")).toBe("反方辩手立论")
  })

  test("yields nothing without the suffix (root, hand-made titles)", () => {
    expect(subagentDescription("New session")).toBeUndefined()
    expect(subagentDescription(undefined)).toBeUndefined()
  })

  test("yields nothing for an empty description", () => {
    expect(subagentDescription("(@general subagent)")).toBeUndefined()
  })
})

describe("formatListTokens", () => {
  test("formats compactly across magnitudes", () => {
    expect(formatListTokens(0)).toBe("0 tok")
    expect(formatListTokens(999)).toBe("999 tok")
    expect(formatListTokens(1000)).toBe("1.0k tok")
    expect(formatListTokens(12_345)).toBe("12.3k tok")
    expect(formatListTokens(1_234_567)).toBe("1.2M tok")
  })

  test("no tokens yet — no readout", () => {
    expect(formatListTokens(undefined)).toBeUndefined()
  })
})

describe("formatListElapsed", () => {
  test("runs live from creation while busy or retrying", () => {
    const input = { statusType: "busy", created: 1000, updated: 2000, now: 61_000 }
    expect(formatListElapsed(input)).toBe(Locale.duration(60_000))
    expect(formatListElapsed({ ...input, statusType: "retry" })).toBe(Locale.duration(60_000))
  })

  test("freezes to the work duration when done", () => {
    const input = { statusType: "idle", created: 1000, updated: 21_000, now: 900_000 }
    expect(formatListElapsed(input)).toBe(Locale.duration(20_000))
  })

  test("no timestamps — no readout", () => {
    expect(formatListElapsed({ statusType: "idle", created: 0, updated: 0, now: 1000 })).toBeUndefined()
  })
})

// Verification finding P4: the persistent panel shares the dialog's row
// anatomy through one owner.
describe("formatAgentRow", () => {
  test("subagent row: indent, name, blurb, type/status/current, meters", () => {
    const row = formatAgentRow({
      member: { id: "a", depth: 1 },
      isRoot: false,
      isCurrent: true,
      info: info(),
      statusType: "busy",
      now: 61_000,
    })
    expect(row.title).toBe("  alpha")
    expect(row.description).toBe("反方辩手立论 · explore · busy · current")
    expect(row.footer).toBe(`1.0k tok · ${Locale.duration(60_000)}`)
  })

  test("Main row: fixed label, no blurb, own meters", () => {
    const row = formatAgentRow({
      member: { id: "root", depth: 0 },
      isRoot: true,
      isCurrent: true,
      info: info({ agent: "build", title: "New session", metadata: {} }),
      statusType: "idle",
      now: 900_000,
    })
    expect(row.title).toBe("Main")
    expect(row.description).toBe("build · idle · current")
  })

  test("nameless subagent falls through type to title parse", () => {
    const row = formatAgentRow({
      member: { id: "x", depth: 2 },
      isRoot: false,
      isCurrent: false,
      info: info({ metadata: {}, agent: undefined, title: "inspect (@explore subagent)" }),
      statusType: "idle",
      now: 1,
    })
    expect(row.title).toBe("    Explore")
    expect(row.description).toBe("inspect · idle")
  })

  test("no info at all — placeholder label, no meters", () => {
    const row = formatAgentRow({
      member: { id: "y", depth: 1 },
      isRoot: false,
      isCurrent: false,
      info: undefined,
      statusType: undefined,
      now: 1,
    })
    expect(row.title).toBe("  Subagent")
    expect(row.description).toBeUndefined()
    expect(row.footer).toBeUndefined()
  })
})
