import type { ModelMessage } from "ai"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

/**
 * The step tail: a short block of facts appended at the very end of one
 * provider request and never written to the session history.
 *
 * It sits after every persisted message, so the request prefix shared with the
 * previous step — and the provider's prompt cache over it — is untouched; it is
 * rebuilt for every step, so old copies never pile up in the history.
 * `provider/transform.ts` keeps cache breakpoints off it by the marker below.
 */

/** Provider-options marker that identifies the tail message. */
export const MARKER = { opencode: { tail: true } } as const

/** The tool calls of one step and what they returned, each in emission order. */
export type StepSignature = {
  readonly calls: readonly string[]
  readonly results: readonly string[]
}

/**
 * How many steps in a row repeated the tool calls of the step before them, and
 * how many of those also got the same results. Lives for one run.
 */
export type Repeat = {
  readonly calls: number
  readonly results: number
}

export const NO_REPEAT: Repeat = { calls: 0, results: 0 }

export function signature(parts: readonly SessionV1.Part[]): StepSignature {
  const tools = parts.filter((part): part is SessionV1.ToolPart => part.type === "tool")
  return {
    calls: tools.map((part) => JSON.stringify([part.tool, part.state.input])),
    results: tools.map((part) => JSON.stringify([part.state.status, outcome(part.state)])),
  }
}

/**
 * Compared with the step before: the same calls count one more repeat, and the
 * same calls with the same results count one more on the second counter too;
 * anything different clears the counter it breaks. A step without tool calls
 * is never a repeat.
 */
export function nextRepeat(previous: StepSignature | undefined, current: StepSignature, repeat: Repeat): Repeat {
  if (!previous || current.calls.length === 0 || !same(previous.calls, current.calls)) return NO_REPEAT
  return {
    calls: repeat.calls + 1,
    results: same(previous.results, current.results) ? repeat.results + 1 : 0,
  }
}

/** Facts only: how often the last step repeated the one before it. */
export function renderRepeat(repeat: Repeat): string | undefined {
  if (repeat.calls === 0) return undefined
  const results =
    repeat.results === 0
      ? "the results differed this time."
      : `the results were identical too: ${times(repeat.results)} in a row.`
  return `Your last step repeated the tool calls of the step before it: ${times(repeat.calls)} in a row; ${results}`
}

/** Joins the non-empty sections, or nothing when there is nothing to say. */
export function render(sections: readonly (string | undefined)[]): string | undefined {
  const present = sections.filter((section): section is string => section !== undefined && section.length > 0)
  return present.length === 0 ? undefined : present.join("\n\n")
}

export function message(text: string): ModelMessage {
  return { role: "user", content: [{ type: "text", text }], providerOptions: MARKER }
}

function outcome(state: SessionV1.ToolPart["state"]) {
  if (state.status === "completed") return state.output
  if (state.status === "error") return state.error
  return ""
}

function same(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

function times(count: number) {
  return count === 1 ? "1 time" : `${count} times`
}

export * as StepTail from "./step-tail"
