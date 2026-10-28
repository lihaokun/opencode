import { MouseButton } from "@opentui/core"

/** What a mouse-up on a user message should do. Left click never opens the
 * menu — clicks are for focus and text selection (issue #69). Right click
 * copies when there is a selection and opens the message menu otherwise;
 * any other button does nothing. */
export type MessageMouseAction = "copy" | "menu" | "none"

export function messageMouseAction(input: {
  button: number
  selectionText?: string | undefined
}): MessageMouseAction {
  if (input.button !== MouseButton.RIGHT) return "none"
  if (input.selectionText) return "copy"
  return "menu"
}
