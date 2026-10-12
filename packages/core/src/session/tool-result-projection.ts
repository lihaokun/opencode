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
