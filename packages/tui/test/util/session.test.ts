import { describe, expect, test } from "bun:test"
import { compareMessageToRevert, earliestMessage, isDefaultTitle, latestMessage } from "../../src/util/session"

describe("util.session", () => {
  test("recognizes generated parent and child titles", () => {
    expect(isDefaultTitle("New session - 2026-06-06T12:34:56.789Z")).toBeTrue()
    expect(isDefaultTitle("Child session - 2026-06-06T12:34:56.789Z")).toBeTrue()
    expect(isDefaultTitle("New session - custom")).toBeFalse()
  })

  test("orders revert boundaries by creation time before ID", () => {
    const before = { id: "msg_ffff", time: { created: 100 } }
    const boundary = { messageID: "msg_0001", messageTimeCreated: 200 }
    const after = { id: "msg_0002", time: { created: 300 } }

    expect(compareMessageToRevert(before, boundary)).toBeLessThan(0)
    expect(compareMessageToRevert(after, boundary)).toBeGreaterThan(0)
  })

  test("preserves raw ID fallback for markers without chronology", () => {
    expect(compareMessageToRevert({ id: "msg_ffff", time: { created: 100 } }, { messageID: "msg_0001" })).toBe(1)
  })

  test("selects chronological neighbors from raw-ID ordered arrays", () => {
    const messages = [
      { id: "msg_0002", time: { created: 300 } },
      { id: "msg_ffff", time: { created: 100 } },
      { id: "msg_0001", time: { created: 200 } },
    ]

    expect(latestMessage(messages, (message) => message.time.created < 300)?.id).toBe("msg_0001")
    expect(earliestMessage(messages, (message) => message.time.created > 100)?.id).toBe("msg_0001")
  })

  test("places a revert dock at the first suffix message when the boundary is missing", () => {
    const messages = [
      { id: "msg_ffff", time: { created: 100 } },
      { id: "msg_0002", time: { created: 300 } },
    ]
    const revert = { messageID: "msg_0001", messageTimeCreated: 200 }

    expect(earliestMessage(messages, (message) => compareMessageToRevert(message, revert) >= 0)?.id).toBe("msg_0002")
  })
})
