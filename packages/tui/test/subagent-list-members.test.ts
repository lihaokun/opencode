import { describe, expect, test } from "bun:test"
import { subagentListMembers, treeRoot } from "../src/routes/session/index"

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
