import { describe, expect, test } from "bun:test"
import { Locale } from "../src/util/locale"
import {
  agentAt,
  agentListRows,
  agentStatusWord,
  contextUsage,
  formatAgentRow,
  formatAgentsLine,
  formatListElapsed,
  lastCompleted,
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

  test("idle freezes at the last assistant completion when known", () => {
    const input = { statusType: "idle", created: 1000, updated: 90_000, completed: 21_000, now: 900_000 }
    expect(formatListElapsed(input)).toBe(Locale.duration(20_000))
  })

  test("idle falls back to the session's updated time without a message time", () => {
    const input = { statusType: "idle", created: 1000, updated: 21_000, now: 900_000 }
    expect(formatListElapsed(input)).toBe(Locale.duration(20_000))
  })

  test("no timestamps — no readout", () => {
    expect(formatListElapsed({ statusType: "idle", created: 0, updated: 0, now: 1000 })).toBeUndefined()
  })
})

describe("agentStatusWord", () => {
  test("maps the status types and is never blank", () => {
    expect(agentStatusWord("busy")).toBe("running")
    expect(agentStatusWord("retry")).toBe("retrying")
    expect(agentStatusWord("idle")).toBe("idle")
    expect(agentStatusWord(undefined)).toBe("idle")
  })
})

describe("lastCompleted", () => {
  test("is the newest completed assistant message, ignoring users and unfinished turns", () => {
    expect(
      lastCompleted([
        { role: "user", time: { created: 1 } },
        { role: "assistant", time: { created: 2, completed: 10 } },
        { role: "assistant", time: { created: 3, completed: 30 } },
        { role: "assistant", time: { created: 4 } },
      ]),
    ).toBe(30)
    expect(lastCompleted([{ role: "user", time: { created: 1 } }])).toBeUndefined()
  })
})

const assistantAt = (completed: number, tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }) => ({
  role: "assistant",
  time: { created: completed - 1, completed },
  tokens,
})

// One line per row: the creator's description at the left; status, elapsed
// and context tokens at the right. No percentage — a wrong configured limit
// used to read as 243%, and the number carries the meaning on its own.
describe("formatAgentRow", () => {
  test("subagent row: indent, description, status · elapsed · tokens", () => {
    const row = formatAgentRow({
      member: { id: "a", depth: 1 },
      isRoot: false,
      info: info(),
      messages: [assistantAt(20_000, { input: 900, output: 60, reasoning: 20, cache: { read: 20, write: 0 } })],
      statusType: "busy",
      now: 61_000,
    })
    expect(row.indent).toBe("  ")
    expect(row.label).toBe("反方辩手立论")
    expect(row.footer).toBe(`running · ${Locale.duration(60_000)} · 1.0K`)
  })

  test("Main row: fixed label; idle freezes at the last completion", () => {
    const row = formatAgentRow({
      member: { id: "root", depth: 0 },
      isRoot: true,
      info: info({ agent: "build", title: "New session", metadata: {}, time: { created: 1000, updated: 90_000 } }),
      messages: [assistantAt(21_000, { input: 12_000, output: 300, reasoning: 0, cache: { read: 45, write: 0 } })],
      statusType: "idle",
      now: 900_000,
    })
    expect(row.indent).toBe("")
    expect(row.label).toBe("Main")
    expect(row.footer).toBe(`idle · ${Locale.duration(20_000)} · 12.3K`)
  })

  test("no description falls through name, then type, then the title's type", () => {
    const named = formatAgentRow({
      member: { id: "x", depth: 2 },
      isRoot: false,
      info: info({ title: "New session", metadata: { agentName: "alpha" } }),
      messages: [],
      statusType: undefined,
      now: 1,
    })
    expect(named.indent).toBe("    ")
    expect(named.label).toBe("alpha")
    const typed = formatAgentRow({
      member: { id: "x", depth: 2 },
      isRoot: false,
      info: info({ title: "(@explore subagent)", metadata: {}, agent: undefined }),
      messages: [],
      statusType: undefined,
      now: 1,
    })
    expect(typed.label).toBe("Explore")
  })

  test("no info at all — placeholder label, status only", () => {
    const row = formatAgentRow({
      member: { id: "y", depth: 1 },
      isRoot: false,
      info: undefined,
      messages: [],
      statusType: undefined,
      now: 1,
    })
    expect(row.label).toBe("Subagent")
    expect(row.footer).toBe("idle")
  })
})

describe("formatAgentsLine", () => {
  test("counts running agents and points at the list", () => {
    expect(formatAgentsLine(0)).toBe("0 agents running · down opens the list")
    expect(formatAgentsLine(1)).toBe("1 agent running · down opens the list")
    expect(formatAgentsLine(3)).toBe("3 agents running · down opens the list")
  })

  test("inside a subagent it opens with where you are", () => {
    expect(formatAgentsLine(2, "cw-b177 (general)")).toBe("in cw-b177 (general) · 2 agents running · down opens the list")
  })
})

describe("agentAt", () => {
  test("name first, with the type in parentheses", () => {
    expect(agentAt(info())).toBe("alpha (explore)")
  })

  test("falls back to the description, then the type, then a placeholder", () => {
    expect(agentAt(info({ metadata: {} }))).toBe("反方辩手立论 (explore)")
    expect(agentAt({ agent: "general", title: "(@general subagent)", metadata: {} })).toBe("general")
    expect(agentAt({ title: "New session" })).toBe("subagent")
  })
})

// Folding: a parent's children that are all finished and did not just finish
// collapse into one "N finished" row; anything with a running descendant, or
// finished within the recent window, stays listed. Expanding a fold shows its
// subtree in full.
describe("agentListRows", () => {
  const timed = (id: string, parentID: string | undefined, created: number, updated: number) => ({
    id,
    parentID,
    time: { created, updated },
  })
  const sessions = [
    timed("root", undefined, 0, 100),
    timed("busy", "root", 10, 100),
    timed("fresh", "root", 20, 95_000),
    timed("old", "root", 30, 1000),
    timed("older", "root", 40, 2000),
    timed("grandchild", "old", 50, 1000),
    timed("quiet-parent", "root", 60, 1000),
    timed("busy-grandchild", "quiet-parent", 70, 1000),
  ]
  const running = (id: string) => id === "busy" || id === "busy-grandchild"
  const base = { sessions, rootID: "root", running, now: 100_000, recentMs: 45_000 }

  test("lists running, recent and parents of running; folds the rest", () => {
    const rows = agentListRows({ ...base, open: new Set() })
    expect(rows).toEqual([
      { kind: "agent", id: "root", depth: 0 },
      { kind: "agent", id: "busy", depth: 1 },
      { kind: "agent", id: "fresh", depth: 1 },
      { kind: "agent", id: "quiet-parent", depth: 1 },
      { kind: "agent", id: "busy-grandchild", depth: 2 },
      { kind: "bucket", parentID: "root", count: 2, depth: 1 },
    ])
  })

  test("an open fold reveals its subtree in full, grandchildren included", () => {
    const rows = agentListRows({ ...base, open: new Set(["root"]) })
    expect(rows.slice(5)).toEqual([
      { kind: "bucket", parentID: "root", count: 2, depth: 1 },
      { kind: "agent", id: "old", depth: 1 },
      { kind: "agent", id: "grandchild", depth: 2 },
      { kind: "agent", id: "older", depth: 1 },
    ])
  })

  test("nothing to fold when everything is live; the root alone is one row", () => {
    expect(agentListRows({ ...base, sessions: [sessions[0]!], open: new Set() })).toEqual([
      { kind: "agent", id: "root", depth: 0 },
    ])
    expect(agentListRows({ ...base, rootID: "missing", open: new Set() })).toEqual([])
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
