import type { IncompleteStreamRecovery } from "@opencode-ai/schema/session-recovery"

export const INCOMPLETE_STREAM_RETRY_LIMIT = 2
export const INCOMPLETE_STREAM_RETRY_INITIAL_DELAY_MS = 2_000
export const INCOMPLETE_STREAM_RETRY_BACKOFF_FACTOR = 2

export interface IncompleteStreamRecoveryInput {
  readonly attempt: number
  readonly limit: number
  readonly blocked: boolean
  readonly persistenceFailed: boolean
  readonly tools: ReadonlyArray<IncompleteStreamRecovery.ToolEvidence>
}

const terminal = (state: IncompleteStreamRecovery.ToolState) => state === "completed" || state === "error"

const validTool = (tool: IncompleteStreamRecovery.ToolEvidence) => {
  if (!tool.id.length || !tool.name.length) return false
  if (!tool.terminalResultPersisted) return true
  return tool.completeCall && tool.inputPersisted && tool.providerExecuted && terminal(tool.state)
}

export const isSettledIncompleteStreamTool = (tool: IncompleteStreamRecovery.ToolEvidence) =>
  tool.completeCall &&
  tool.inputPersisted &&
  tool.providerExecuted &&
  tool.terminalResultPersisted &&
  terminal(tool.state) &&
  !tool.interrupted

const validInput = (input: IncompleteStreamRecoveryInput) => {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 0) return false
  if (!Number.isSafeInteger(input.limit) || input.limit < 0 || input.attempt > input.limit) return false
  const ids = new Set<string>()
  for (const tool of input.tools) {
    if (!validTool(tool) || ids.has(tool.id)) return false
    ids.add(tool.id)
  }
  return true
}

const recovery = (
  input: IncompleteStreamRecoveryInput,
  action: IncompleteStreamRecovery.Action,
  reason: IncompleteStreamRecovery.Reason,
): IncompleteStreamRecovery.Info => ({
  classification: "incomplete-stream",
  action,
  reason,
  tools: [...input.tools],
  retry: { attempt: input.attempt, limit: input.limit },
})

const invalidRecovery = (input: IncompleteStreamRecoveryInput): IncompleteStreamRecovery.Info => {
  const limit = Number.isSafeInteger(input.limit) && input.limit >= 0 ? input.limit : INCOMPLETE_STREAM_RETRY_LIMIT
  const attempt = Number.isSafeInteger(input.attempt) && input.attempt >= 0 ? Math.min(input.attempt, limit) : 0
  return {
    classification: "incomplete-stream",
    action: "manual-stop",
    reason: "persistence-failure",
    tools: [],
    retry: { attempt, limit },
  }
}

export const classifyIncompleteStreamRecovery = (
  input: IncompleteStreamRecoveryInput,
): IncompleteStreamRecovery.Info => {
  // # Step P2: Classify the frozen facts conservatively before a caller performs any recovery side effect.
  if (!validInput(input)) return invalidRecovery(input)
  if (input.blocked) return recovery(input, "manual-stop", "blocked")
  if (input.persistenceFailed) return recovery(input, "manual-stop", "persistence-failure")
  if (input.tools.length === 0) {
    if (input.attempt < input.limit) return recovery(input, "safe-retry", "no-tool-evidence")
    return recovery(input, "manual-stop", "retry-exhausted")
  }
  if (input.tools.every(isSettledIncompleteStreamTool)) {
    return recovery(input, "continue-after-settled-tools", "settled-tools")
  }
  return recovery(input, "manual-stop", "uncertain-side-effect")
}

export const incompleteStreamRetryDelay = (attempt: number) => {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > INCOMPLETE_STREAM_RETRY_LIMIT) return undefined
  return INCOMPLETE_STREAM_RETRY_INITIAL_DELAY_MS * INCOMPLETE_STREAM_RETRY_BACKOFF_FACTOR ** (attempt - 1)
}
