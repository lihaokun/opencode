import { describe, expect, test } from "bun:test"
import { collectSubtree } from "../src/routes/session/index"

// With nesting allowed, a permission or question request can come from a
// grandchild. Collecting only direct children leaves it unanswerable anywhere —
// the child's own view shows nothing — so that Agent waits forever.
describe("collectSubtree", () => {
  const tree = [
    { id: "root" },
    { id: "a", parentID: "root" },
    { id: "b", parentID: "a" },
    { id: "c", parentID: "b" },
    { id: "sibling", parentID: "root" },
    { id: "unrelated" },
    { id: "unrelated-child", parentID: "unrelated" },
  ]

  test("reaches a grandchild three levels down", () => {
    const result = collectSubtree(tree, "root")
    expect(result).toContain("root")
    expect(result).toContain("a")
    expect(result).toContain("b")
    expect(result).toContain("c")
  })

  test("stays within the subtree", () => {
    const result = collectSubtree(tree, "a")
    expect(result.toSorted()).toEqual(["a", "b", "c"])
    expect(result).not.toContain("root")
    expect(result).not.toContain("sibling")
  })

  test("excludes another root's tree", () => {
    const result = collectSubtree(tree, "root")
    expect(result).not.toContain("unrelated")
    expect(result).not.toContain("unrelated-child")
  })

  test("a lone session is its own subtree", () => {
    expect(collectSubtree([{ id: "solo" }], "solo")).toEqual(["solo"])
  })

  test("terminates even if the data contains a cycle", () => {
    const cyclic = [
      { id: "x", parentID: "y" },
      { id: "y", parentID: "x" },
    ]
    expect(collectSubtree(cyclic, "x").toSorted()).toEqual(["x", "y"])
  })
})
