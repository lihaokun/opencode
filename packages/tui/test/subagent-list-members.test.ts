import { describe, expect, test } from "bun:test"
import { subagentListMembers } from "../src/routes/session/index"

// INV-4: the list is exactly the view's subtree minus the root session and
// the session being viewed — no duplicates, grandchildren reachable, direct
// children first.
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

  test("lists direct children first, then the grandchild, excluding root and current", () => {
    expect(subagentListMembers(tree, "root", "root")).toEqual([
      { id: "a", depth: 1 },
      { id: "b", depth: 1 },
      { id: "g", depth: 2 },
    ])
  })

  test("sorts siblings of equal depth by creation time", () => {
    const byTime = [session("root"), session("late", "root", 10), session("early", "root", 5)]
    expect(subagentListMembers(byTime, "root", "root").map((m) => m.id)).toEqual(["early", "late"])
  })

  test("from a child's seat: siblings and nephews, not self, not root", () => {
    expect(subagentListMembers(tree, "root", "a")).toEqual([
      { id: "b", depth: 1 },
      { id: "g", depth: 2 },
    ])
  })

  test("a grandchild's seat: uncles, cousins, and its own parent's other children", () => {
    expect(subagentListMembers(tree, "root", "g")).toEqual([
      { id: "a", depth: 1 },
      { id: "b", depth: 1 },
    ])
  })

  test("no subagents yields an empty list — the keystroke stays with the editor", () => {
    expect(subagentListMembers([session("root")], "root", "root")).toEqual([])
    expect(subagentListMembers([], "root", "root")).toEqual([])
  })

  test("the current session is excluded even when it is a grandchild", () => {
    expect(subagentListMembers(tree, "root", "g").map((m) => m.id)).not.toContain("g")
  })
})
