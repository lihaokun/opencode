import { MouseButton } from "@opentui/core"

/** What a mouse-up on a user message should do. Left click never opens the
 * menu — clicks are for focus and text selection (issue #69). Right click
 * opens the message menu; any other button does nothing.
 *
 * Two notes on the remaining branches, both consequences of the renderer
 * clearing the selection after any button-down that is not preventDefaulted
 * (opentui CliRenderer.processSingleMouseEvent):
 *
 * - `consumedByCopy`: the selection-copy happens on the right-button *down*
 *   (the message row's onMouseDown), because that is the last moment the
 *   selection still exists. When the down copied, the press is spent and the
 *   matching up must not also open the menu.
 * - the `selectionText` copy branch is defensive only: on the up there is
 *   normally no selection left to see. Keep it so a renderer that stops
 *   clearing on down degrades to copy-instead-of-menu rather than opening a
 *   menu over a selection the user meant to copy. */
export type MessageMouseAction = "copy" | "menu" | "none"

export function messageMouseAction(input: {
  button: number
  selectionText?: string | undefined
  consumedByCopy?: boolean | undefined
}): MessageMouseAction {
  if (input.button !== MouseButton.RIGHT) return "none"
  if (input.consumedByCopy) return "none"
  if (input.selectionText) return "copy"
  return "menu"
}
