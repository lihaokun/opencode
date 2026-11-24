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

// Matches V1 Truncate hints, V1 ShellTool truncation headers, and Core V2 ToolOutputStore markers.
const V1_SAVED_OUTPUT_RE =
  /(?:^|\r?\n)The tool call (?:failed; error output was truncated|succeeded but the output was truncated)\. Full output saved to: ([^\r\n]{1,32767})\r?\nUse Grep to search the full content or Read with offset\/limit to view specific sections\.(?=\r?\n|$)/g

const SHELL_SAVED_OUTPUT_RE =
  /(?:^|\r?\n)\.\.\.output truncated\.\.\.\r?\n\r?\nFull output saved to: ([^\r\n]{1,32767})(?=\r?\n|$)/g

const V2_SAVED_OUTPUT_RE =
  /(?:^|\r?\n)\.\.\. output truncated; full content saved to ([^\r\n]{1,32767}) \.\.\.(?=\r?\n|$)/g

const TRUNCATION_BOUNDARY_RE = /^\r?\n\[\.\.\. \d+ chars truncated \.\.\.\]\r?\n/

// Extract every artifact pointer emitted by V1 Truncate, V1 ShellTool, or Core V2 ToolOutputStore.
export function savedOutputPaths(text: string): string[] {
  const found: Array<{ index: number; file: string }> = []
  for (const regex of [V1_SAVED_OUTPUT_RE, SHELL_SAVED_OUTPUT_RE, V2_SAVED_OUTPUT_RE]) {
    for (const match of text.matchAll(regex)) {
      if (match[1]) found.push({ index: match.index ?? 0, file: match[1] })
    }
  }
  found.sort((a, b) => a.index - b.index)
  return found.map((item) => item.file)
}

// Prefer the trailing pointer when text quotes an earlier truncated tool output.
export function savedOutputPath(text: string) {
  return savedOutputPaths(text).at(-1)
}

function containsCompletePointer(preview: string, needle: string) {
  let from = 0
  while (from <= preview.length) {
    const idx = preview.indexOf(needle, from)
    if (idx === -1) return false
    const rest = preview.slice(idx + needle.length)
    if (rest === "" || ((rest.startsWith("\n") || rest.startsWith("\r\n")) && !TRUNCATION_BOUNDARY_RE.test(rest))) {
      return true
    }
    from = idx + 1
  }
  return false
}

export function hasOutputPath(preview: string, file: string) {
  return (
    containsCompletePointer(preview, "Full output saved to: " + file) ||
    containsCompletePointer(preview, "... output truncated; full content saved to " + file + " ...")
  )
}

export function appendMissingOutputPaths(preview: string, files: Iterable<string>) {
  const missing = new Set<string>()
  for (const file of files) {
    if (file && !hasOutputPath(preview, file)) missing.add(file)
  }
  if (missing.size === 0) return preview
  // Leave room for a maximum-length artifact path even when the text preview
  // is full. A result with many artifacts cannot make the summary unbounded.
  const references: string[] = []
  let remaining = 32_767 + "\nFull output saved to: ".length
  for (const file of missing) {
    const line = "\nFull output saved to: " + file
    if (line.length > remaining) continue
    references.push(line)
    remaining -= line.length
  }
  const omitted = missing.size - references.length
  const body =
    preview +
    references.join("") +
    (omitted ? `\n[${omitted} more artifact ${omitted === 1 ? "path" : "paths"} in the original tool result]` : "")
  return preview ? body : body.replace(/^\n/, "")
}

export function summarizeToolError(text: string) {
  const preview = summarizeToolText(text)
  if (preview === text) return preview
  return appendMissingOutputPaths(preview, savedOutputPaths(text))
}
