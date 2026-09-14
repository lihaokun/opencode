import { describe, expect, test } from "bun:test"
import { Permission } from "@/permission"

// Legacy `task` config is rewritten to `agent` when config is read. Dropping it
// would widen permissions on upgrade, so the rewrite is the thing that keeps an
// existing `task: deny` honest — and these pin the parts of it that are easy to
// get subtly wrong.
describe("legacy task permission migration", () => {
  test("a legacy rule takes effect under the canonical key", () => {
    const ruleset = Permission.fromConfig({ task: { "*": "deny" } })
    expect(Permission.evaluate("agent", "anything", ruleset).action).toBe("deny")
  })

  test("nothing is left behind under the old key", () => {
    const ruleset = Permission.fromConfig({ task: { "*": "deny" } })
    expect(ruleset.some((rule) => rule.permission === "task")).toBe(false)
  })

  // evaluate takes the last match, so the rewritten rules have to land ahead of
  // the explicit ones. Either order in the source object must give the same
  // answer: the explicit key wins.
  test("an explicit agent rule wins over a legacy one, whichever comes first", () => {
    const legacyFirst = Permission.fromConfig({ task: { reviewer: "deny" }, agent: { reviewer: "allow" } })
    expect(Permission.evaluate("agent", "reviewer", legacyFirst).action).toBe("allow")

    const canonicalFirst = Permission.fromConfig({ agent: { reviewer: "allow" }, task: { reviewer: "deny" } })
    expect(Permission.evaluate("agent", "reviewer", canonicalFirst).action).toBe("allow")
  })

  test("a legacy rule still applies to subagent types the explicit rules do not name", () => {
    const ruleset = Permission.fromConfig({ task: { "*": "deny" }, agent: { reviewer: "allow" } })
    expect(Permission.evaluate("agent", "reviewer", ruleset).action).toBe("allow")
    expect(Permission.evaluate("agent", "someone-else", ruleset).action).toBe("deny")
  })

  test("the string shorthand migrates too", () => {
    const ruleset = Permission.fromConfig({ task: "deny" })
    expect(Permission.evaluate("agent", "anything", ruleset).action).toBe("deny")
  })

  test("unrelated keys keep their original position", () => {
    const ruleset = Permission.fromConfig({ "*": "deny", bash: "allow", task: "allow" })
    expect(Permission.evaluate("bash", "ls", ruleset).action).toBe("allow")
    expect(Permission.evaluate("read", "x", ruleset).action).toBe("deny")
  })
})
