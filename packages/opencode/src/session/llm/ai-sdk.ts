import { FinishReason, LLMEvent, ProviderMetadata, ToolResultValue } from "@opencode-ai/llm"
import { Effect, Schema } from "effect"
import { type streamText } from "ai"
import { errorMessage } from "@/util/error"
import { ProviderError } from "@/provider/error"

type Result = Awaited<ReturnType<typeof streamText>>
type AISDKEvent = Result["fullStream"] extends AsyncIterable<infer T> ? T : never

const incompleteStreamMessage = "Provider stream ended without a terminal finish event"
const openAICompatibleReasoningID = "reasoning-0"
const openAICompatibleTextID = "txt-0"

type ReasoningNormalization = Readonly<{
  coalesceOpenAICompatibleReasoning: boolean
}>

function createAdapterState(normalization: ReasoningNormalization) {
  return {
    normalization,
    step: 0,
    text: 0,
    reasoning: 0,
    currentTextID: undefined as string | undefined,
    currentReasoningID: undefined as string | undefined,
    pendingReasoningEnd: undefined as
      | { id: typeof openAICompatibleReasoningID; textID: typeof openAICompatibleTextID | undefined }
      | undefined,
    normalizationDisabled: false,
    normalizationReasoningActive: false,
    toolNames: {} as Record<string, string>,
    copilotTotalNanoAiu: undefined as number | undefined,
    terminalFailure: false,
  }
}

export function adapterState(
  options: { readonly coalesceOpenAICompatibleReasoning?: boolean } = {},
) {
  return createAdapterState(
    Object.freeze({
      coalesceOpenAICompatibleReasoning: options.coalesceOpenAICompatibleReasoning === true,
    }),
  )
}

function resetAdapterState(state: ReturnType<typeof adapterState>) {
  Object.assign(state, createAdapterState(state.normalization))
}

export function drainPendingReasoningEnd(state: ReturnType<typeof adapterState>): ReadonlyArray<LLMEvent> {
  const pending = state.pendingReasoningEnd
  if (!pending) return []
  state.pendingReasoningEnd = undefined
  state.currentReasoningID = undefined
  state.normalizationReasoningActive = false
  return [LLMEvent.reasoningEnd({ id: pending.id })]
}

function finishReason(value: string | undefined): FinishReason {
  return Schema.is(FinishReason)(value) ? value : "unknown"
}

function providerMetadata(value: unknown): ProviderMetadata | undefined {
  if (value == null) return undefined
  return Schema.is(ProviderMetadata)(value) ? value : undefined
}

// Temporary AI SDK bridge: Copilot billing survives only in raw provider chunks here.
// Move this extraction into @opencode-ai/llm when Copilot is handled by the native runtime.
function copilotTotalNanoAiu(value: unknown) {
  if (!value || typeof value !== "object") return
  const raw = value as Record<string, unknown>
  const response =
    raw.response && typeof raw.response === "object" ? (raw.response as Record<string, unknown>) : undefined
  const usage = raw.copilot_usage ?? response?.copilot_usage
  if (!usage || typeof usage !== "object") return
  const total = (usage as Record<string, unknown>).total_nano_aiu
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return
  return total
}

function usage(value: unknown) {
  if (!value || typeof value !== "object") return undefined
  const item = value as {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    reasoningTokens?: number
    cachedInputTokens?: number
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number }
    outputTokenDetails?: { reasoningTokens?: number }
  }
  const entries = Object.entries({
    inputTokens: item.inputTokens,
    outputTokens: item.outputTokens,
    totalTokens: item.totalTokens,
    reasoningTokens: item.outputTokenDetails?.reasoningTokens ?? item.reasoningTokens,
    cacheReadInputTokens: item.inputTokenDetails?.cacheReadTokens ?? item.cachedInputTokens,
    cacheWriteInputTokens: item.inputTokenDetails?.cacheWriteTokens,
  }).filter((entry) => entry[1] !== undefined)
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

function currentTextID(state: ReturnType<typeof adapterState>, id: string | undefined) {
  state.currentTextID = id ?? state.currentTextID ?? `text-${state.text++}`
  return state.currentTextID
}

function currentReasoningID(state: ReturnType<typeof adapterState>, id: string | undefined) {
  state.currentReasoningID = id ?? state.currentReasoningID ?? `reasoning-${state.reasoning++}`
  return state.currentReasoningID
}

function mapNormally(
  state: ReturnType<typeof adapterState>,
  event: AISDKEvent,
): Effect.Effect<ReadonlyArray<LLMEvent>, unknown> {
  if (state.terminalFailure) {
    if (event.type !== "finish") return Effect.succeed([])
    return Effect.sync(() => {
      resetAdapterState(state)
      return []
    })
  }

  switch (event.type) {
    case "start":
      return Effect.succeed([])

    case "start-step":
      return Effect.succeed([LLMEvent.stepStart({ index: state.step })])

    case "finish-step":
      if (event.rawFinishReason === "network_error")
        return Effect.fail(new ProviderError.ResponseStreamError("Provider finish_reason: network_error"))
      return Effect.sync(() => {
        const original = providerMetadata(event.providerMetadata)
        const metadata =
          state.copilotTotalNanoAiu === undefined
            ? original
            : {
                ...original,
                copilot: {
                  ...original?.copilot,
                  totalNanoAiu: state.copilotTotalNanoAiu,
                },
              }
        state.copilotTotalNanoAiu = undefined
        const events: LLMEvent[] = [
          LLMEvent.stepFinish({
            index: state.step++,
            reason: finishReason(event.finishReason),
            usage: usage(event.usage),
            providerMetadata: metadata,
          }),
        ]
        if (event.finishReason === "other" && event.rawFinishReason === undefined) {
          state.terminalFailure = true
          events.push(
            LLMEvent.providerError({
              message: incompleteStreamMessage,
              classification: "incomplete-stream",
              retryable: false,
            }),
          )
        }
        return events
      })

    case "finish":
      return Effect.sync(() => {
        const events = [
          LLMEvent.finish({
            reason: finishReason(event.finishReason),
            usage: usage(event.totalUsage),
            providerMetadata: "providerMetadata" in event ? providerMetadata(event.providerMetadata) : undefined,
          }),
        ]
        // Reset so the adapter can be reused for a follow-up stream without leaking
        // counters or block IDs. createAdapterState() is the single source of truth for shape.
        resetAdapterState(state)
        return events
      })

    case "text-start":
      return Effect.sync(() => {
        state.currentTextID = currentTextID(state, event.id)
        return [
          LLMEvent.textStart({
            id: state.currentTextID,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "text-delta":
      return Effect.succeed([
        LLMEvent.textDelta({
          id: currentTextID(state, event.id),
          text: event.text,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "text-end":
      return Effect.sync(() => {
        const id = currentTextID(state, event.id)
        state.currentTextID = undefined
        return [
          LLMEvent.textEnd({
            id,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "reasoning-start":
      return Effect.sync(() => {
        state.currentReasoningID = currentReasoningID(state, event.id)
        return [
          LLMEvent.reasoningStart({
            id: state.currentReasoningID,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "reasoning-delta":
      return Effect.succeed([
        LLMEvent.reasoningDelta({
          id: currentReasoningID(state, event.id),
          text: event.text,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "reasoning-end":
      return Effect.sync(() => {
        const id = currentReasoningID(state, event.id)
        state.currentReasoningID = undefined
        return [
          LLMEvent.reasoningEnd({
            id,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-input-start":
      return Effect.sync(() => {
        state.toolNames[event.id] = event.toolName
        return [
          LLMEvent.toolInputStart({
            id: event.id,
            name: event.toolName,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-input-delta":
      return Effect.succeed([
        LLMEvent.toolInputDelta({
          id: event.id,
          name: state.toolNames[event.id] ?? "unknown",
          text: event.delta ?? "",
        }),
      ])

    case "tool-input-end":
      return Effect.succeed([
        LLMEvent.toolInputEnd({
          id: event.id,
          name: state.toolNames[event.id] ?? "unknown",
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "tool-call":
      return Effect.sync(() => {
        state.toolNames[event.toolCallId] = event.toolName
        return [
          LLMEvent.toolCall({
            id: event.toolCallId,
            name: event.toolName,
            input: event.input,
            providerExecuted: "providerExecuted" in event ? event.providerExecuted : undefined,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-result":
      return Effect.sync(() => {
        const name = state.toolNames[event.toolCallId] ?? "unknown"
        delete state.toolNames[event.toolCallId]
        return [
          LLMEvent.toolResult({
            id: event.toolCallId,
            name,
            result: ToolResultValue.make(event.output),
            providerExecuted: "providerExecuted" in event ? event.providerExecuted : undefined,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-error":
      return Effect.sync(() => {
        const name = state.toolNames[event.toolCallId] ?? ("toolName" in event ? event.toolName : "unknown")
        delete state.toolNames[event.toolCallId]
        return [
          LLMEvent.toolError({
            id: event.toolCallId,
            name,
            message: errorMessage(event.error),
            error: event.error,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "error":
      return Effect.fail(event.error)

    case "abort":
    case "source":
    case "file":
    case "tool-output-denied":
    case "tool-approval-request":
      return Effect.succeed([])

    case "raw":
      return Effect.sync(() => {
        state.copilotTotalNanoAiu = copilotTotalNanoAiu(event.rawValue) ?? state.copilotTotalNanoAiu
        return []
      })

    default: {
      const _exhaustive: never = event
      void _exhaustive
      return Effect.succeed([])
    }
  }
}

function prepend(
  prefix: ReadonlyArray<LLMEvent>,
  effect: Effect.Effect<ReadonlyArray<LLMEvent>, unknown>,
): Effect.Effect<ReadonlyArray<LLMEvent>, unknown> {
  if (prefix.length === 0) return effect
  return effect.pipe(Effect.map((events) => [...prefix, ...events]))
}

export function toLLMEvents(
  state: ReturnType<typeof adapterState>,
  event: AISDKEvent,
): Effect.Effect<ReadonlyArray<LLMEvent>, unknown> {
  return Effect.suspend(() => {
    if (state.terminalFailure) return mapNormally(state, event)
    if (!state.normalization.coalesceOpenAICompatibleReasoning) return mapNormally(state, event)
    if (event.type === "raw") return mapNormally(state, event)
    if (event.type === "error") return mapNormally(state, event)

    if (
      (event.type === "reasoning-start" || event.type === "reasoning-delta" || event.type === "reasoning-end") &&
      event.providerMetadata != null
    ) {
      const prefix = drainPendingReasoningEnd(state)
      state.normalizationDisabled = true
      state.normalizationReasoningActive = false
      return prepend(prefix, mapNormally(state, event))
    }

    if (state.normalizationDisabled) return mapNormally(state, event)

    if (event.type === "reasoning-start") {
      if (
        event.id === openAICompatibleReasoningID &&
        state.pendingReasoningEnd?.textID === openAICompatibleTextID
      ) {
        state.pendingReasoningEnd = undefined
        return Effect.succeed([])
      }

      const prefix = drainPendingReasoningEnd(state)
      if (event.id !== openAICompatibleReasoningID) {
        state.normalizationReasoningActive = false
        return prepend(prefix, mapNormally(state, event))
      }
      return mapNormally(state, event).pipe(
        Effect.map((events) => {
          state.normalizationReasoningActive = true
          return [...prefix, ...events]
        }),
      )
    }

    if (event.type === "reasoning-delta") {
      if (
        event.id === openAICompatibleReasoningID &&
        state.pendingReasoningEnd?.textID === openAICompatibleTextID
      ) {
        state.pendingReasoningEnd = undefined
        return mapNormally(state, event)
      }

      const prefix = drainPendingReasoningEnd(state)
      if (event.id !== openAICompatibleReasoningID) state.normalizationReasoningActive = false
      return prepend(prefix, mapNormally(state, event))
    }

    if (event.type === "reasoning-end") {
      const eligible =
        event.id === openAICompatibleReasoningID &&
        state.normalizationReasoningActive &&
        state.currentReasoningID === openAICompatibleReasoningID &&
        (state.currentTextID === undefined || state.currentTextID === openAICompatibleTextID)
      if (eligible) {
        state.pendingReasoningEnd ??= {
          id: openAICompatibleReasoningID,
          textID: undefined,
        }
        return Effect.succeed([])
      }

      const prefix = drainPendingReasoningEnd(state)
      state.normalizationReasoningActive = false
      return prepend(prefix, mapNormally(state, event))
    }

    if (event.type === "text-start" || event.type === "text-delta") {
      let prefix: ReadonlyArray<LLMEvent> = []
      if (state.pendingReasoningEnd) {
        if (
          event.id === openAICompatibleTextID &&
          (state.currentTextID === undefined || state.currentTextID === openAICompatibleTextID)
        ) {
          state.pendingReasoningEnd.textID = openAICompatibleTextID
        } else {
          prefix = drainPendingReasoningEnd(state)
        }
      }
      return prepend(prefix, mapNormally(state, event))
    }

    const prefix = drainPendingReasoningEnd(state)
    return prepend(prefix, mapNormally(state, event))
  })
}

export * as LLMAISDK from "./ai-sdk"
