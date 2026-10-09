import { describe, expect, test } from "bun:test"
import { Locale } from "../src/util/locale"
import {
  contextUsage,
  formatAgentRow,
  formatListElapsed,
  subagentDescription,
  subagentListMembers,
  treeRoot,
} from "../src/routes/session/index"

const session = (id: string, parentID?: string, created = 0) => ({
  id,
  parentID,
  time: { created },
})

const info = (over: Record<string, unknown> = {}) => ({
  agent: "explore",
  title: "反方辩手立论 (@general subagent)",
  metadata: { agentName: "alpha" },
  time: { created: 1000, updated: 21_000 },
  ...over,
})

// INV-4 (revised per verification finding P1): the list is the tree's full
// membership — root, every subagent, and the session being viewed. One list,
// one navigation surface; where the viewer sits is conveyed by the current
// marker in the dialog, not by omitting rows. Direct children sort first,
// then by creation time; grandchildren indent beneath their elders.
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
// anatomy through one owner. P5: meters use the shared context-usage
// convention (last assistant message, % of limit), no "tok" unit, and the
// "current" text marker is gone — highlighting is each surface's job.
describe("formatAgentRow", () => {
  test("subagent row: indent, name, blurb, type/status, context meter", () => {
    const row = formatAgentRow({
      member: { id: "a", depth: 1 },
      isRoot: false,
      info: info(),
      usage: { tokens: 1000, pct: "12%" },
      statusType: "busy",
      now: 61_000,
    })
    expect(row.indent).toBe("  ")
    expect(row.label).toBe("alpha")
    expect(row.description).toBe("反方辩手立论 · explore · busy")
    expect(row.footer).toBe(`1.0K (12%) · ${Locale.duration(60_000)}`)
  })

  test("Main row: fixed label, no blurb, own meter", () => {
    const row = formatAgentRow({
      member: { id: "root", depth: 0 },
      isRoot: true,
      info: info({ agent: "build", title: "New session", metadata: {} }),
      usage: { tokens: 12_345, pct: undefined },
      statusType: "idle",
      now: 900_000,
    })
    expect(row.indent).toBe("")
    expect(row.label).toBe("Main")
    expect(row.description).toBe("build · idle")
    expect(row.footer).toBe(`12.3K · ${Locale.duration(20_000)}`)
  })

  test("nameless subagent falls through type to title parse", () => {
    const row = formatAgentRow({
      member: { id: "x", depth: 2 },
      isRoot: false,
      info: info({ metadata: {}, agent: undefined, title: "inspect (@explore subagent)" }),
      usage: undefined,
      statusType: "idle",
      now: 1,
    })
    expect(row.indent).toBe("    ")
    expect(row.label).toBe("Explore")
    expect(row.description).toBe("inspect · idle")
  })

  test("no info at all — placeholder label, no meters", () => {
    const row = formatAgentRow({
      member: { id: "y", depth: 1 },
      isRoot: false,
      info: undefined,
      usage: undefined,
      statusType: undefined,
      now: 1,
    })
    expect(row.indent).toBe("  ")
    expect(row.label).toBe("Subagent")
    expect(row.description).toBeUndefined()
    expect(row.footer).toBeUndefined()
  })
})

describe("contextUsage", () => {
  const assistant = (
    tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
    providerID = "p",
    modelID = "m",
  ) => ({
    role: "assistant",
    tokens,
    providerID,
    modelID,
  })
  const providers = [{ id: "p", models: { m: { limit: { context: 10_000 } } } }]

  test("aggregates the last scoring assistant message with its limit pct", () => {
    const readout = contextUsage({
      messages: [
        assistant({ input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }),
        assistant({ input: 1000, output: 50, reasoning: 20, cache: { read: 30, write: 0 } }),
      ],
      providers,
    })
    expect(readout).toEqual({ tokens: 1100, pct: "11%" })
  })

  test("ignores assistant messages without output (no scoring yet)", () => {
    const readout = contextUsage({
      messages: [assistant({ input: 5000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })],
      providers,
    })
    expect(readout).toBeUndefined()
  })

  test("no limit — tokens without pct", () => {
    const readout = contextUsage({
      messages: [assistant({ input: 100, output: 1, reasoning: 0, cache: { read: 0, write: 0 } })],
      providers: [],
    })
    expect(readout).toEqual({ tokens: 101, pct: undefined })
  })
})
