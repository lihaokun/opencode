import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { SessionID } from "../session/schema"

export interface Limits {
  maxLines: number
  maxBytes: number
}

function escapeMarkup(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case '"':
        return "&quot;"
      case "'":
        return "&apos;"
      default:
        return char
    }
  })
}

function bound(value: string, limits: Limits) {
  const maxLines = Math.max(1, limits.maxLines)
  const maxBytes = Math.max(1, limits.maxBytes)
  let text = ""
  let bytes = 0
  let lines = 1

  for (const point of value) {
    if (point === "\n" && lines >= maxLines) break
    const size = Buffer.byteLength(escapeMarkup(point), "utf8")
    if (bytes + size > maxBytes) break
    text += point
    bytes += size
    if (point === "\n") lines += 1
  }

  return { text, truncated: text.length < value.length }
}

function allVisibleText(result: SessionV1.WithParts) {
  return result.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
}

/**
 * The last text part, not every text part joined. Joining is only for failure
 * excerpts; using it for a normal result mixes intermediate thinking into the
 * answer. Returns "" when there is none, which a run that ended in tool calls
 * legitimately produces.
 */
export function lastVisibleText(result: SessionV1.WithParts) {
  return result.parts.findLast((part) => part.type === "text")?.text ?? ""
}

export function hasUsableOutput(result: SessionV1.WithParts) {
  return result.parts.some((part) => {
    if (part.type === "text") return part.text.trim().length > 0
    if (part.type === "tool") return part.state.status !== "pending"
    return false
  })
}

export function formatIncompleteResponse(sessionID: SessionID, finish: "missing" | "unknown") {
  return [
    "Subagent task failed: IncompleteResponse",
    `Child session: ${sessionID}`,
    `finish_reason=${finish}`,
    "No visible output or complete tool call was produced",
  ].join("\n")
}

export function formatOutputLengthFailure(
  result: SessionV1.WithParts & { info: SessionV1.Assistant },
  sessionID: SessionID,
  limits: Limits,
) {
  const text = allVisibleText(result)
  const output = [
    "Subagent task failed: MessageOutputLengthError",
    `Child session: ${sessionID}`,
    "finish_reason=length",
    `reasoning_tokens=${result.info.tokens.reasoning}`,
    `output_tokens=${result.info.tokens.output}`,
    "The task is incomplete; the filesystem and version-control state may contain partial changes.",
  ]
  if (!text) {
    output.push("No visible output was produced")
    return output.join("\n")
  }

  const excerpt = bound(text, limits)
  output.push("Partial output excerpt:", excerpt.text)
  if (excerpt.truncated) {
    output.push("", `Partial output truncated. Full content is available in child session ${sessionID}`)
  }
  return output.join("\n")
}

export function formatSubagentFailure(message: string, sessionID: SessionID, limits: Limits) {
  const bounded = bound(message, limits)
  const output = [`Subagent failed (session_id: ${sessionID}): ${bounded.text}`]
  if (bounded.truncated) {
    output.push("", `Error message truncated. Full context is available in child session ${sessionID}`)
  }
  return output.join("\n")
}

export function formatAssistantFailure(
  result: SessionV1.WithParts & { info: SessionV1.Assistant },
  sessionID: SessionID,
  limits: Limits,
) {
  const error = result.info.error
  if (!error || error.name === "MessageOutputLengthError") {
    return formatOutputLengthFailure(result, sessionID, limits)
  }
  const message = typeof error.data?.message === "string" ? error.data.message : error.name
  return formatSubagentFailure(`${error.name}: ${message}`, sessionID, limits)
}

export function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error" | "cancelled"
  summary?: string
  text: string
}) {
  const tag = input.state === "error" || input.state === "cancelled" ? "agent_error" : "agent_result"
  return [
    `<agent id="${escapeMarkup(input.sessionID)}" state="${escapeMarkup(input.state)}">`,
    ...(input.summary ? [`<summary>${escapeMarkup(input.summary)}</summary>`] : []),
    `<${tag}>`,
    escapeMarkup(input.text),
    `</${tag}>`,
    "</agent>",
  ].join("\n")
}

export type Outcome =
  | { kind: "completed"; text: string }
  | { kind: "failed"; text: string }
  | { kind: "cancelled" }

/**
 * Classify a finished delegation. The order is load-bearing: an abort is also an
 * error, so checking for it second would report a cancellation as a failure and
 * settle the job as `error` rather than `cancelled`.
 *
 * Copied branch for branch from the task tool rather than simplified — this is
 * what a delegation's result *is*, and the notification channel carries it.
 */
export function classify(result: SessionV1.WithParts, sessionID: SessionID, limits: Limits): Outcome {
  if (result.info.role !== "assistant") {
    return { kind: "failed", text: "Task prompt returned a non-assistant result" }
  }
  const info = result.info
  if (info.error?.name === "MessageAbortedError") return { kind: "cancelled" }
  if (info.error || info.finish === "length") {
    return { kind: "failed", text: formatAssistantFailure({ info, parts: result.parts }, sessionID, limits) }
  }
  const failed = result.parts.findLast((item) => item.type === "tool" && item.state.status === "error")
  if (failed?.type === "tool" && failed.state.status === "error") {
    return { kind: "failed", text: formatSubagentFailure(failed.state.error, sessionID, limits) }
  }
  const incompleteFinish = info.finish === undefined ? "missing" : info.finish === "unknown" ? "unknown" : undefined
  if (incompleteFinish && !hasUsableOutput(result)) {
    return { kind: "failed", text: formatIncompleteResponse(sessionID, incompleteFinish) }
  }
  // May be "" for a run that ended in tool calls. That is a completed
  // delegation with no prose, not a failure, and inventing filler here would
  // render a normal outcome as a problem.
  return { kind: "completed", text: lastVisibleText(result) }
}

/**
 * Collapse an outcome onto the Effect exit the background job settles from.
 * Three distinct exits are required: the job's status is derived from the exit,
 * so returning a tagged value on the success channel would settle every job as
 * completed.
 */
export function toExit(outcome: Outcome): Effect.Effect<string, Error> {
  if (outcome.kind === "completed") return Effect.succeed(outcome.text)
  if (outcome.kind === "failed") return Effect.fail(new Error(outcome.text))
  return Effect.interrupt
}

export * as AgentDelegation from "./delegation"
