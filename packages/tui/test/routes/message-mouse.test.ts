import { describe, expect, test } from "bun:test"
import { messageMouseAction } from "../../src/routes/session/message-mouse"
import { revertConfirmMessage } from "../../src/routes/session/dialog-message"
import type { MessageMouseAction } from "../../src/routes/session/message-mouse"

// MouseButton values from @opentui/core: LEFT = 0, MIDDLE = 1, RIGHT = 2.
const LEFT = 0
const MIDDLE = 1
const RIGHT = 2

describe("messageMouseAction", () => {
  test("left click does nothing, selection or not", () => {
    expect(messageMouseAction({ button: LEFT })).toBe<MessageMouseAction>("none")
    expect(messageMouseAction({ button: LEFT, selectionText: "selected" })).toBe<MessageMouseAction>("none")
  })

  test("right click with a selection copies", () => {
    expect(messageMouseAction({ button: RIGHT, selectionText: "selected" })).toBe<MessageMouseAction>("copy")
  })

  test("right click without a selection opens the menu", () => {
    expect(messageMouseAction({ button: RIGHT })).toBe<MessageMouseAction>("menu")
    expect(messageMouseAction({ button: RIGHT, selectionText: "" })).toBe<MessageMouseAction>("menu")
    expect(messageMouseAction({ button: RIGHT, selectionText: undefined })).toBe<MessageMouseAction>("menu")
  })

  test("middle click does nothing", () => {
    expect(messageMouseAction({ button: MIDDLE })).toBe<MessageMouseAction>("none")
  })

  test("wheel buttons do nothing", () => {
    expect(messageMouseAction({ button: 4 })).toBe<MessageMouseAction>("none")
    expect(messageMouseAction({ button: 5 })).toBe<MessageMouseAction>("none")
  })
})

describe("revertConfirmMessage", () => {
  test("singular wording for one message", () => {
    const text = revertConfirmMessage({ reverted: 1, stale: false })
    expect(text).toContain("the 1 message after this one")
    expect(text).toContain("<leader>r")
    expect(text).toContain("/redo")
    expect(text).not.toContain("7 days")
  })

  test("plural wording for several messages", () => {
    const text = revertConfirmMessage({ reverted: 3, stale: false })
    expect(text).toContain("the 3 messages after this one")
    expect(text).not.toContain("7 days")
  })

  test("stale messages add the snapshot warning", () => {
    const text = revertConfirmMessage({ reverted: 2, stale: true })
    expect(text).toContain("older than 7 days")
    expect(text).toContain("snapshot may have been pruned")
  })
})
