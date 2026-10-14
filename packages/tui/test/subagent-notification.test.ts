import { describe, expect, test } from "bun:test"
import type { Part, TextPart } from "@opencode-ai/sdk/v2"
import { agentNotificationSummary } from "../src/routes/session/index"

// The delegation outcome reaches the TUI as a synthetic text part whose
// envelope is what the model reads. Recognition must go through metadata
// alone (INV-2): parsing the envelope would couple this UI to a model-facing
// format, and every case below is a way that coupling would eventually break.
function text(overrides: Partial<TextPart> = {}): Part {
  return {
    id: "p1",
    sessionID: "ses",
    messageID: "msg",
    type: "text",
    text: '<agent id="ses_x" state="completed">\n<summary>Agent completed: task</summary>\n</agent>',
    synthetic: true,
    ...overrides,
  }
}

describe("agentNotificationSummary", () => {
  test("returns the summary of a delegation notification part", () => {
    const parts = [text({ metadata: { kind: "agent_notification", summary: "Agent completed: 统计行数" } })]
    expect(agentNotificationSummary(parts)).toBe("Agent completed: 统计行数")
  })

  test("finds the notification among other synthetic parts", () => {
    const parts = [
      text({ metadata: { kind: "editor_context", source: "editor" } }),
      text({ metadata: { kind: "agent_notification", summary: "Agent failed: look around" } }),
    ]
    expect(agentNotificationSummary(parts)).toBe("Agent failed: look around")
  })

  test("returns undefined without metadata — old transcripts stay as they were (Step P13)", () => {
    expect(agentNotificationSummary([text()])).toBeUndefined()
  })

  test("returns undefined for a different metadata kind", () => {
    expect(agentNotificationSummary([text({ metadata: { kind: "editor_context" } })])).toBeUndefined()
  })

  test("returns undefined when the summary is not a string", () => {
    expect(agentNotificationSummary([text({ metadata: { kind: "agent_notification", summary: 42 } })])).toBeUndefined()
  })

  test("ignores non-text parts carrying the same metadata shape", () => {
    // No SDK part type besides TextPart declares metadata today, so this
    // pins the runtime guard rather than a reachable wire shape.
    const file = {
      id: "p2",
      sessionID: "ses",
      messageID: "msg",
      type: "file",
      mime: "text/plain",
      url: "file:///x",
      filename: "x",
      metadata: { kind: "agent_notification", summary: "nope" },
    } as unknown as Part
    expect(agentNotificationSummary([file])).toBeUndefined()
  })
})
