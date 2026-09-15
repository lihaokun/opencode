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

  // The one that matters. Moving the converted rules ahead of an explicit
  // `agent` key also moves them past whatever sits in between, and a wildcard
  // in between applies to every key. This config used to migrate into a ruleset
  // where an unnamed subagent came out allowed, having been denied before.
  test("a wildcard between the keys is not stepped over", () => {
    const ruleset = Permission.fromConfig({ task: "allow", "*": "deny", agent: { reviewer: "allow" } })
    expect(ruleset.map((rule) => `${rule.permission}:${rule.pattern}=${rule.action}`)).toEqual([
      "agent:*=allow",
      "*:*=deny",
      "agent:reviewer=allow",
    ])
    expect(Permission.evaluate("agent", "someone", ruleset).action).toBe("deny")
    expect(Permission.evaluate("agent", "reviewer", ruleset).action).toBe("allow")
  })

  // Same question asked of the sequence itself rather than of one outcome: a
  // rename must not disturb any position, whatever the keys are interleaved with.
  test("the rename leaves the sequence identical position for position", () => {
    const config = { task: "allow", "*": "deny", bash: "allow", agent: { reviewer: "ask" } } as const
    const migrated = Permission.fromConfig(config)
    const asIfNeverLegacy = Permission.fromConfig({
      agent: "allow",
      "*": "deny",
      bash: "allow",
      // the explicit agent rule this config would have carried
    })
    expect(migrated.slice(0, 3)).toEqual(asIfNeverLegacy)
    expect(migrated.at(-1)).toEqual({ permission: "agent", pattern: "reviewer", action: "ask" })
  })

  // Suppression is about the explicit rule winning, not about dropping coverage.
  test("a legacy pattern the explicit rules do not name survives", () => {
    const ruleset = Permission.fromConfig({ task: { reviewer: "deny", writer: "deny" }, agent: { reviewer: "allow" } })
    expect(Permission.evaluate("agent", "reviewer", ruleset).action).toBe("allow")
    expect(Permission.evaluate("agent", "writer", ruleset).action).toBe("deny")
  })
})
