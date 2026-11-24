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
  const prefix = text.slice(0, head).replace(/[\uD800-\uDBFF]$/, "")
  const suffix = text.slice(-TOOL_RESULT_SUMMARY_TAIL_CHARS).replace(/^[\uDC00-\uDFFF]/, "")
  return `${prefix}\n[... ${text.length - prefix.length - suffix.length} chars truncated ...]\n${suffix}`
}

// Matches both V1 Truncate hints and Core V2 ToolOutputStore markers.
const V1_SAVED_OUTPUT_RE =
  /(?:^|\r?\n)The tool call (?:failed; error output was truncated|succeeded but the output was truncated)\. Full output saved to: ([^\r\n]{1,32767})\r?\nUse Grep to search the full content or Read with offset\/limit to view specific sections\.(?=\r?\n|$)/g

const V2_SAVED_OUTPUT_RE =
  /(?:^|\r?\n)\.\.\. output truncated; full content saved to ([^\r\n]{1,32767}) \.\.\.(?=\r?\n|$)/g

// Extract every artifact pointer emitted by V1 Truncate or Core V2 ToolOutputStore.
export function savedOutputPaths(text: string): string[] {
  const found: Array<{ index: number; file: string }> = []
  for (const match of text.matchAll(V1_SAVED_OUTPUT_RE)) {
    if (match[1]) found.push({ index: match.index ?? 0, file: match[1] })
  }
  for (const match of text.matchAll(V2_SAVED_OUTPUT_RE)) {
    if (match[1]) found.push({ index: match.index ?? 0, file: match[1] })
  }
  found.sort((a, b) => a.index - b.index)
  return found.map((item) => item.file)
}

// Prefer the trailing pointer when text quotes an earlier truncated tool output.
export function savedOutputPath(text: string) {
  return savedOutputPaths(text).at(-1)
}

export function hasOutputPath(preview: string, file: string) {
  const v1 = "Full output saved to: " + file
  if (preview.endsWith(v1) || preview.includes(v1 + "\n") || preview.includes(v1 + "\r\n")) return true
  const v2 = "... output truncated; full content saved to " + file + " ..."
  return preview.endsWith(v2) || preview.includes(v2 + "\n") || preview.includes(v2 + "\r\n")
}

export function summarizeToolError(text: string) {
  const preview = summarizeToolText(text)
  if (preview === text) return preview
  const saved = savedOutputPath(text)
  return saved && !hasOutputPath(preview, saved) ? preview + "\nFull output saved to: " + saved : preview
}
