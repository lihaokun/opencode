/**
 * Shared projections from persisted tool-part state to model-visible text.
 *
 * Two formatters render tool state for a model: the session replay projection
 * (packages/opencode/src/session/message-v2.ts) and the compaction summary
 * projection (packages/core/src/session/compaction.ts and its opencode twin).
 * Keep the per-field rules here so the two cannot drift.
 */

/**
 * One-line rendering of a tool's exit status for model consumption.
 *
 * Only a finite, non-zero numeric `exit` produces a line: success (0) stays
 * silent to avoid a line on every command, and null (timeout/abort) is already
 * described by the tool's own output prose. Callers append the returned line
 * after the tool output text.
 */
export function formatExitCodeLine(metadata: unknown): string | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined
  const value = (metadata as Record<string, unknown>).exit
  if (typeof value !== "number" || !Number.isFinite(value) || value === 0) return undefined
  return `[exit code: ${value}]`
}

export const TOOL_RESULT_SUMMARY_MAX_CHARS = 2_000
const TOOL_RESULT_SUMMARY_TAIL_CHARS = 600

/**
 * Summary-side projection of a tool result: head/tail retention instead of a
 * head-only cut. Tool outputs anchor their continuation handles at the two
 * ends — generic tools put the full-output path and read-more hint at the
 * tail, shell puts the path at the head and timeout/abort diagnostics at the
 * tail — so a single-sided cut always loses one of them. Results within
 * budget pass through byte-identical. Pure truncation: exit/compacted flags
 * are session-schema concepts and stay at the call site.
 */
export function summarizeToolText(text: string): string {
  if (text.length <= TOOL_RESULT_SUMMARY_MAX_CHARS) return text
  const head = TOOL_RESULT_SUMMARY_MAX_CHARS - TOOL_RESULT_SUMMARY_TAIL_CHARS
  const omitted = text.length - TOOL_RESULT_SUMMARY_MAX_CHARS
  return `${text.slice(0, head)}\n[... ${omitted} chars truncated ...]\n${text.slice(-TOOL_RESULT_SUMMARY_TAIL_CHARS)}`
}
