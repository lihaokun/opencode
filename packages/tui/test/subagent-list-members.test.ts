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
import { agentListOptions } from "../src/component/dialog-subagent-list"

const session = (id: string, parentID?: string, created = 0) => ({
  id,
  parentID,
  time: { created },
})

const timed = (id: string, parentID: string | undefined, created: number, updated: number) => ({
  id,
  parentID,
  time: { created, updated },
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

const assistantAt = (
  completed: number,
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
) => ({
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
    expect(formatAgentsLine(2, "cw-b177 (general)")).toBe(
      "in cw-b177 (general) · 2 agents running · down opens the list",
    )
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
// collapse into one "N finished" row; anything with a running or just-finished
// descendant stays listed. Expanding a fold shows its subtree in full.
describe("agentListRows", () => {
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

  test("the viewed session and its ancestors never fold, however old", () => {
    const rows = agentListRows({ ...base, pinned: "grandchild", open: new Set() })
    expect(rows.map((row) => (row.kind === "agent" ? row.id : `fold:${row.count}`))).toEqual([
      "root",
      "busy",
      "fresh",
      "old",
      "grandchild",
      "quiet-parent",
      "busy-grandchild",
      "fold:1",
    ])
  })

  test("nothing to fold when everything is live; the root alone is one row", () => {
    expect(agentListRows({ ...base, sessions: [sessions[0]!], open: new Set() })).toEqual([
      { kind: "agent", id: "root", depth: 0 },
    ])
    expect(agentListRows({ ...base, rootID: "missing", open: new Set() })).toEqual([])
  })

  // Review finding (round 2): recency was checked on the child alone, so a
  // parent that finished long ago folded away together with the grandchild
  // that had finished a second earlier — the recent window was lost at depth 2.
  test("a just-finished grandchild keeps its long-finished parent listed", () => {
    const three = [
      timed("root", undefined, 0, 100),
      timed("parent", "root", 10, 1000),
      timed("grandchild", "parent", 20, 99_000),
    ]
    const rows = agentListRows({ ...base, sessions: three, running: () => false, pinned: "root", open: new Set() })
    expect(rows).toEqual([
      { kind: "agent", id: "root", depth: 0 },
      { kind: "agent", id: "parent", depth: 1 },
      { kind: "agent", id: "grandchild", depth: 2 },
    ])
  })

  test("fold: false lists every agent in tree order with no fold rows, whatever is open", () => {
    const all = ["root", "busy", "fresh", "old", "grandchild", "older", "quiet-parent", "busy-grandchild"]
    for (const open of [new Set<string>(), new Set(["root", "old"])]) {
      const rows = agentListRows({ ...base, open, fold: false })
      expect(rows.map((row) => (row.kind === "agent" ? row.id : "fold"))).toEqual(all)
    }
  })
})

// The dialog's options. Review finding (round 2): DialogSelect filters only
// the options it is given, so an agent inside a fold could not be found by
// typing its title — the query had to be cleared and the fold opened by hand.
describe("agentListOptions", () => {
  const titles: Record<string, string> = {
    root: "New session",
    busy: "Review the tests (@general subagent)",
    old: "Rewrite the parser (@general subagent)",
  }
  const base = {
    sessions: [timed("root", undefined, 0, 100), timed("busy", "root", 10, 100), timed("old", "root", 20, 1000)],
    rootID: "root",
    currentID: "root",
    running: (id: string) => id === "busy",
    now: 100_000,
    open: new Set<string>(),
    info: (id: string) => ({ title: titles[id], metadata: {}, time: { created: 0, updated: 0 } }),
    messages: () => [],
    statusType: (id: string) => (id === "busy" ? "busy" : "idle"),
  }

  test("an old task is folded until its title is typed; the match is the task itself, not the fold", () => {
    const folded = agentListOptions({ ...base, query: "" })
    expect(folded.map((option) => option.value)).toEqual(["root", "busy", "fold:root"])
    expect(folded[2]!.title).toBe("  ▸ 1 finished")

    // Typing lists everything, so DialogSelect's fuzzy filter can see the old
    // task; its title carries the description the user types, and selecting
    // the option hands the dialog that session's id to enter.
    const typed = agentListOptions({ ...base, query: "parser" })
    expect(typed.map((option) => option.value)).toEqual(["root", "busy", "old"])
    expect(typed[2]!.title).toBe("  Rewrite the parser")
    expect(typed[2]!.footer).toBe("idle")

    // Clearing the query restores the fold exactly: `open` is never touched by typing.
    expect(agentListOptions({ ...base, query: "" })).toEqual(folded)
  })

  test("an open fold stays open through typing and is shown open again once the query clears", () => {
    const open = new Set(["root"])
    const before = agentListOptions({ ...base, open, query: "" })
    expect(before.map((option) => option.value)).toEqual(["root", "busy", "fold:root", "old"])
    expect(before[2]!.title).toBe("  ▾ 1 finished")
    expect(agentListOptions({ ...base, open, query: "x" }).map((option) => option.value)).toEqual([
      "root",
      "busy",
      "old",
    ])
    expect(agentListOptions({ ...base, open, query: "" })).toEqual(before)
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

// §5.3 layer 3: random trees. Seeded, so a failure names its case. Checked
// against the rules the folding is defined by rather than against a copy of
// the implementation.
function rng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe("agentListRows on random trees", () => {
  test("running or recent nodes and their ancestors are always rows; folds count exactly the quiet, stale children", () => {
    for (let n = 0; n < 60; n++) {
      const next = rng(5000 + n)
      const label = `seed ${5000 + n}`
      const now = 1_000_000
      const recentMs = 45_000
      const count = 1 + Math.floor(next() * 14)
      const sessions = [{ id: "s0", parentID: undefined as string | undefined, time: { created: 0, updated: 0 } }]
      for (let i = 1; i < count; i++) {
        const parent = sessions[Math.floor(next() * i)]!.id
        const created = i * 10
        const updated = next() < 0.4 ? now - Math.floor(next() * 30_000) : Math.floor(next() * 500_000)
        sessions.push({ id: `s${i}`, parentID: parent, time: { created, updated } })
      }
      const busy = new Set(sessions.filter(() => next() < 0.25).map((item) => item.id))
      const running = (id: string) => busy.has(id)
      const open = new Set(sessions.filter(() => next() < 0.3).map((item) => item.id))
      const rows = agentListRows({ sessions, rootID: "s0", running, now, recentMs, open })

      const byId = new Map(sessions.map((item) => [item.id, item]))
      const children = (id: string) => sessions.filter((item) => item.parentID === id)
      // Live: running, or finished within the recent window, or above a node
      // that is — recency climbs the tree exactly as running does (round 2).
      const live = (item: (typeof sessions)[number]): boolean =>
        running(item.id) || now - item.time.updated < recentMs || children(item.id).some(live)
      const agents = rows.flatMap((row) => (row.kind === "agent" ? [row] : []))
      const ids = agents.map((row) => row.id)

      // Root first, no duplicates.
      expect(ids[0], label).toBe("s0")
      expect(new Set(ids).size, label).toBe(ids.length)
      // Every live node — running or recent, at any depth — and every ancestor
      // of one is a row.
      for (const item of sessions) {
        if (!live(item)) continue
        expect(ids, `${label} live ${item.id}`).toContain(item.id)
      }
      // A node is a row iff its parent is a row and it is live or inside a
      // revealed fold — an expanded fold shows its subtree in full.
      for (const item of sessions) {
        if (item.id === "s0") continue
        const parentShown = ids.includes(item.parentID!)
        expect(ids.includes(item.id), `${label} row ${item.id}`).toBe(
          parentShown && (live(item) || revealedThrough(item.id)),
        )
      }
      // Each fold counts exactly its parent's children that are not live.
      for (const row of rows) {
        if (row.kind !== "bucket") continue
        const quiet = children(row.parentID).filter((kid) => !live(kid))
        expect(row.count, `${label} fold under ${row.parentID}`).toBe(quiet.length)
        expect(row.depth, label).toBe((agents.find((a) => a.id === row.parentID)?.depth ?? -2) + 1)
      }
      // Depth is the distance from the root.
      for (const row of agents) {
        let depth = 0
        for (let cursor = byId.get(row.id); cursor?.parentID; cursor = byId.get(cursor.parentID)) depth += 1
        expect(row.depth, `${label} depth ${row.id}`).toBe(depth)
      }
      // With folding off there are no fold rows and every session is a row, in
      // tree order: depth first, siblings by creation time.
      const unfolded = agentListRows({ sessions, rootID: "s0", running, now, recentMs, open, fold: false })
      const treeOrder = (id: string): string[] => [
        id,
        ...children(id)
          .toSorted((a, b) => a.time.created - b.time.created)
          .flatMap((kid) => treeOrder(kid.id)),
      ]
      expect(
        unfolded.map((row) => (row.kind === "agent" ? row.id : "fold")),
        label,
      ).toEqual(treeOrder("s0"))

      // Some ancestor (or the node itself) is a quiet child of a parent whose
      // fold is open and who is itself a row.
      function revealedThrough(id: string): boolean {
        for (let cursor = byId.get(id); cursor?.parentID; cursor = byId.get(cursor.parentID)) {
          const parent = byId.get(cursor.parentID)!
          if (!live(cursor) && open.has(parent.id) && ids.includes(parent.id)) return true
        }
        return false
      }
    }
  })
})
