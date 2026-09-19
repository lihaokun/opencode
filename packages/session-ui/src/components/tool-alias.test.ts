import { describe, expect, test } from "bun:test"
import { isAgentTool, resolveToolName } from "./tool-alias"

// A session recorded before the rename still holds parts under `task`. Without
// the alias those cards fall through to the unknown-tool renderer, which is a
// silent regression in every transcript older than the rename.
describe("tool aliases", () => {
  test("agent resolves to itself", () => {
    expect(resolveToolName("agent")).toBe("agent")
  })

  test("the tool's former name resolves to it", () => {
    expect(resolveToolName("task")).toBe("agent")
  })

  test("the existing aliases still hold", () => {
    expect(resolveToolName("apply_patch")).toBe("patch")
    expect(resolveToolName("bash")).toBe("shell")
  })

  test("an unknown name is left alone", () => {
    expect(resolveToolName("glob")).toBe("glob")
  })
})

// The memos behind a subagent card — the child session id, the link to it and
// the subtitle — all key off this, so a historical part has to pass it or the
// card renders without a way to jump into the child session.
describe("isAgentTool", () => {
  test.each(["agent", "task"])("%s is the agent tool", (name) => {
    expect(isAgentTool(name)).toBe(true)
  })

  test.each(["bash", "glob", "read", undefined])("%s is not", (name) => {
    expect(isAgentTool(name)).toBe(false)
  })
})
