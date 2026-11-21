import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { LLM } from "./llm"
import { estimatePayload, estimateMessages, calibratedInput, recoveryBoundaries, providerGap } from "./summary-budget"
import { Token } from "@/util/token"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"

import { Effect, Layer, Context, Option, Cause, Exit } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, usable } from "./overflow"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { buildPrompt } from "@opencode-ai/core/session/compaction"
import {
  formatExitCodeLine,
  hasOutputPath,
  summarizeToolText,
  summarizeToolError,
} from "@opencode-ai/core/session/tool-result-projection"
import { SessionCompactionEvent } from "@opencode-ai/schema/session-compaction-event"

export const Event = SessionCompactionEvent

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 15_000
type Turn = {
  start: number
  end: number
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

const serialize = (message: SessionV1.WithParts) => {
  if (message.info.role === "user") {
    const text = message.parts
      .filter((part): part is SessionV1.TextPart => part.type === "text" && !part.ignored)
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n")
    const files = message.parts.flatMap((part) =>
      part.type === "file" ? [`[Attached ${part.mime}: ${part.filename ?? "file"}]`] : [],
    )
    return [...(text ? [`[User]: ${text}`] : []), ...files].join("\n")
  }
  return message.parts
    .flatMap((part) => {
      if (part.type === "text") return part.text ? [`[Assistant]: ${part.text}`] : []
      if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
      if (part.type !== "tool") return []
      const call = `[Assistant tool call]: ${part.tool}(${JSON.stringify(part.state.input)})`
      if (part.state.status === "completed") {
        const attachments = (part.state.attachments ?? []).map(
          (item) => `[Attached ${item.mime}: ${item.filename ?? "file"}]`,
        )
        const preview = part.state.time.compacted
          ? "[Old tool result content cleared]"
          : summarizeToolText([part.state.output, ...attachments].join("\n"))
        const saved = part.state.metadata.outputPath
        const text =
          !part.state.time.compacted && typeof saved === "string" && saved && !hasOutputPath(preview, saved)
            ? preview + "\nFull output saved to: " + saved
            : preview
        const exit = part.state.time.compacted ? undefined : formatExitCodeLine(part.state.metadata)
        return [call, `[Tool result]: ${exit ? `${text}\n${exit}` : text}`]
      }
      if (part.state.status === "error") return [call, `[Tool error]: ${summarizeToolError(part.state.error)}`]
      return [call]
    })
    .join("\n")
}

function summaryText(message: SessionV1.WithParts) {
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: SessionV1.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

function preserveRecentBudget(input: { cfg: ConfigV1.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

// Old pending overflow markers lack a request ID. For usage-triggered compaction,
// several users may already be waiting after the last completed working step.
function protectedStart(
  originals: SessionV1.WithParts[],
  marker: SessionV1.CompactionPart | undefined,
  auto: boolean,
  overflow?: boolean,
) {
  if (!marker) return -1
  if (marker.protected_from) return originals.findIndex((row) => row.info.id === marker.protected_from)
  if (overflow) return originals.findLastIndex((row) => row.info.role === "user")
  if (!auto) return -1
  const finished = originals.findLast((row) => row.info.role === "assistant" && row.info.finish && !row.info.error)
  return finished
    ? originals.findIndex((row) => row.info.role === "user" && MessageV2.compareChronology(row.info, finished.info) > 0)
    : -1
}

function turns(messages: SessionV1.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: SessionV1.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: SessionV1.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return start
    }
    return undefined
  })
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly willOverflow: (input: {
    system: string[]
    messages: ReadonlyArray<unknown>
    tools: unknown
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly process: (input: {
    parentID: MessageID
    messages: SessionV1.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    auto: boolean
    overflow?: boolean
    protectedFrom?: MessageID
    requestUserID?: MessageID
    fixedInputTokens?: number
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({
        cfg: yield* config.get(),
        tokens: input.tokens,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
    })

    // Estimate the canonical pre-transport payload before the request is sent.
    // Unlike isOverflow (which reads the previous finished turn's reported
    // tokens), this catches a single-step overshoot in the current payload.
    const willOverflow = Effect.fn("SessionCompaction.willOverflow")(function* (input: {
      system: string[]
      messages: ReadonlyArray<unknown>
      tools: unknown
      model: Provider.Model
    }) {
      const cfg = yield* config.get()
      if (cfg.compaction?.auto === false) return false
      if (input.model.limit.context === 0) return false
      const size = Token.estimate(
        JSON.stringify({ system: input.system, messages: input.messages, tools: input.tools }),
      )
      return size >= usable({ cfg, model: input.model, outputTokenMax: flags.outputTokenMax })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: SessionV1.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: SessionV1.WithParts[]
      available?: number
      cfg: ConfigV1.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns
      if (limit !== undefined && limit <= 0) return input.messages
      const budget = Math.min(preserveRecentBudget({ cfg: input.cfg, model: input.model }), input.available ?? Infinity)
      const measure =
        input.available === undefined
          ? estimate
          : Effect.fnUntraced(function* (args: { messages: SessionV1.WithParts[]; model: Provider.Model }) {
              return estimateMessages(yield* MessageV2.toModelMessagesEffect(args.messages, args.model))
            })
      const all = turns(input.messages)
      if (!all.length) return input.messages
      const recent = limit === undefined ? all : all.slice(-limit)

      let total = 0
      let keep: number | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        // estimate lazily so cost stays proportional to the retained tail, not the whole session
        const size = yield* measure({
          messages: input.messages.slice(turn.start, turn.end),
          model: input.model,
        })
        if (total + size <= budget) {
          total += size
          keep = turn.start
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate: measure,
        })
        if (split !== undefined) keep = split
        else if (!keep) {
          yield* Effect.logInfo("tail fallback", { budget, size, total })
        }
        break
      }

      if (!keep) return input.messages
      return input.messages.slice(0, keep)
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      yield* Effect.logInfo("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: SessionV1.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      yield* Effect.logInfo("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        yield* Effect.logInfo("pruned", { count: toPrune.length })
      }
    })

    const latestUser = Effect.fnUntraced(function* (sessionID: SessionID) {
      const found = yield* session.findMessage(sessionID, (message) => message.info.role === "user").pipe(Effect.orDie)
      if (Option.isNone(found) || found.value.info.role !== "user") return undefined
      // Generated IDs agree with SQLite ordering. A custom Unicode winner can
      // disagree with JS chronology at the same timestamp (see latestRole).
      if (!/[\uD800-\uDFFF]/.test(found.value.info.id)) return found.value.info
      return MessageV2.latest(yield* session.messages({ sessionID }).pipe(Effect.orDie)).user
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: SessionV1.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      // The marker owns the history boundary, while the newest user owns the
      // execution configuration. They differ when a failed summary is retried.
      const userMessage = MessageV2.latest(input.messages).user ?? parent.info
      const compactionPart = parent.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")

      // A retry can have new inputs after its marker. Those belong to the
      // next turn, not to this summary or its retained tail.
      const history = compactionPart ? input.messages.slice(0, input.messages.indexOf(parent)) : input.messages
      const originals = history.filter(MessageV2.isOriginal)
      const anchor = compactionPart?.protected_from
      const start = protectedStart(originals, compactionPart, input.auto, input.overflow)
      const mandatory = start < 0 ? [] : originals.slice(start)
      const historyForSummary = start < 0 ? originals : originals.slice(0, start)
      const currentInput = originals.findLast((m) => m.info.role === "user")?.info
      const configUser = userMessage.id === parent.info.id && currentInput?.role === "user" ? currentInput : userMessage
      const agent = yield* agents.get("compaction")
      const model = agent.model
        ? yield* provider.getModel(agent.model.providerID, agent.model.modelID).pipe(Effect.orDie)
        : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID).pipe(Effect.orDie)
      const ordinaryModel = input.auto ? configUser.model : userMessage.model
      const primary =
        model.providerID === ordinaryModel.providerID && model.id === ordinaryModel.modelID
          ? model
          : yield* provider.getModel(ordinaryModel.providerID, ordinaryModel.modelID).pipe(Effect.orDie)
      const cfg = yield* config.get()
      const previousSummary = completedCompactions(history).at(-1)?.summary
      const budgeted = primary.limit.context > 0 && mandatory.length > 0
      // Arrivals before the marker still need replay, but attachments from users
      // outside the rejected request must reach the next model unchanged.
      const requestUser = compactionPart?.request_user_id
      const mediaEnd = requestUser ? mandatory.findIndex((row) => row.info.id === requestUser) : 0
      const rawRequired = mandatory.map((row, index) =>
        input.overflow && index <= mediaEnd ? MessageV2.withoutUserMedia(row) : row,
      )
      const room = budgeted
        ? usable({ cfg, model: primary, outputTokenMax: flags.outputTokenMax }) -
          ((requestUser ?? anchor) === configUser.id ? (compactionPart?.fixed_input_tokens ?? 0) : 0) -
          estimateMessages(yield* MessageV2.toModelMessagesEffect(rawRequired, primary))
        : Infinity
      const optionalBudget = Math.max(
        0,
        Math.min(room, Math.floor(usable({ cfg, model: primary, outputTokenMax: flags.outputTokenMax }) / 4)),
      )
      let head = yield* select({
        messages: historyForSummary,
        cfg,
        model: input.auto ? primary : model,
        available: input.auto && primary.limit.context > 0 ? optionalBudget : undefined,
      })
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const summaryPrompt = Effect.fnUntraced(function* (head: SessionV1.WithParts[]) {
        const msgs = structuredClone(head)
        yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
        const conversation = msgs.map(serialize).filter(Boolean).join("\n\n")
        const prompt =
          compacting.prompt ??
          [buildPrompt({ previousSummary, context: [conversation] }), ...compacting.context]
            .filter(Boolean)
            .join("\n\n")
        return compacting.prompt
          ? [prompt, "The following is the conversation history:", conversation].filter(Boolean).join("\n\n")
          : prompt
      })
      const ctx = yield* InstanceState.context
      const msg: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      const prepare = Effect.fnUntraced(function* (head: SessionV1.WithParts[]) {
        const text = yield* summaryPrompt(head)
        const stream: LLM.StreamInput = {
          user: userMessage,
          agent,
          sessionID: input.sessionID,
          tools: {},
          system: [],
          messages: [{ role: "user", content: [{ type: "text", text }] }],
          model,
        }
        const preparedPayload = yield* llm.preparePayload(stream)
        return { ...stream, preparedPayload }
      })
      const summarize = Effect.fnUntraced(function* (stream: LLM.StreamInput) {
        msg.n = mandatory.length + historyForSummary.length - head.length
        yield* session.updateMessage(msg)
        const processor = yield* processors.create({ assistantMessage: msg, sessionID: input.sessionID, model })
        const result = yield* processor.process(stream)
        return { result, error: processor.summaryOverflow }
      })
      if (room <= 0 || (anchor && start < 0)) {
        msg.error = new SessionV1.ContextOverflowError({
          message:
            room <= 0
              ? "Required user turn plus system and tools exceeds the available input budget"
              : "Required user input is unavailable for compaction",
        }).toObject()
        msg.finish = "error"
        msg.time.completed = Date.now()
        yield* session.updateMessage(msg)
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: msg.error })
        return "stop"
      }
      const original = yield* prepare(head)
      const attempt = yield* Effect.gen(function* () {
        let attempt = yield* summarize(original)
        if (attempt.result === "compact" && compactionPart && head.length > 1 && cfg.compaction?.tail_turns !== 0) {
          const budget = usable({ cfg, model, outputTokenMax: flags.outputTokenMax })
          const cap = Math.min(optionalBudget, cfg.compaction?.preserve_recent_tokens ?? Infinity)
          if (budget > 0 && cap > 0) {
            const originalSize = yield* Effect.promise(() => estimatePayload(original.preparedPayload))
            const sample = (yield* session.get(input.sessionID).pipe(Effect.orDie)).metadata?.summaryBudgetSample
            const anchor = history.findLast((m) => m.info.id === sample?.messageID)?.info
            const baseline =
              anchor?.role === "assistant" &&
              anchor.finish &&
              !anchor.error &&
              anchor.providerID === model.providerID &&
              anchor.modelID === model.id &&
              Number.isSafeInteger(sample?.estimate) &&
              sample.estimate > 0
                ? {
                    actual: anchor.tokens.input + anchor.tokens.cache.read + anchor.tokens.cache.write,
                    estimate: sample.estimate,
                  }
                : undefined
            const gap =
              providerGap(attempt.error?.message ?? "") ??
              providerGap(attempt.error?.responseBody ?? "") ??
              calibratedInput(originalSize, baseline) - budget
            const groups = turns(historyForSummary)
            const minGroup = Math.max(0, groups.length - (cfg.compaction?.tail_turns ?? Infinity))
            // Work backwards once. Estimate the amount removed in summary form
            // separately from the cost of replaying that group as model messages.
            const candidates: { start: number; reduction: number }[] = []
            let end = head.length
            const replayCost = Effect.fnUntraced(function* (slice: SessionV1.WithParts[]) {
              return estimateMessages(yield* MessageV2.toModelMessagesEffect(slice, primary))
            })
            let retained = yield* replayCost(historyForSummary.slice(end))
            let removedChars = 0
            for (let i = groups.length - 1; i >= minGroup; i--) {
              const start = groups[i]!.start
              if (start >= end) continue
              if (start === 0) break
              const group = historyForSummary.slice(start, end)
              retained += yield* replayCost(group)
              if (retained > cap) break
              for (const message of group) {
                const text = serialize(message)
                if (text) removedChars += text.length + 2
              }
              candidates.push({ start, reduction: Math.ceil(removedChars / 3) })
              end = start
            }
            const plan = recoveryBoundaries(budget, gap, candidates)
            let cursor = plan.next()
            while (!cursor.done && attempt.result === "compact") {
              const { start, target } = cursor.value
              const candidate = historyForSummary.slice(0, start)
              const stream = yield* prepare(candidate)
              const reduction = originalSize - (yield* Effect.promise(() => estimatePayload(stream.preparedPayload)))
              if (reduction < target) {
                cursor = plan.next(undefined)
                continue
              }
              if ((yield* replayCost(historyForSummary.slice(start))) > cap) break
              head = candidate
              attempt = yield* summarize(stream)
              cursor = plan.next(reduction)
            }
          }
        }
        return attempt
      }).pipe(
        Effect.onExit((exit) => {
          if (Exit.isSuccess(exit) || msg.error || msg.finish) return Effect.void
          // Preparing a shorter candidate is interruptible too, between calls to
          // SessionProcessor. Settle the one pending row on cancellation/defect.
          const interrupted = Cause.hasInterruptsOnly(exit.cause)
          msg.error = MessageV2.fromError(
            interrupted ? new DOMException("Compaction interrupted", "AbortError") : Cause.squash(exit.cause),
            { providerID: model.providerID, aborted: interrupted },
          )
          msg.finish = "error"
          msg.time.completed = Date.now()
          return session
            .updateMessage(msg)
            .pipe(
              Effect.andThen(events.publish(Session.Event.Error, { sessionID: input.sessionID, error: msg.error })),
              Effect.asVoid,
            )
        }),
      )
      if (attempt.result === "compact") {
        msg.error = new SessionV1.ContextOverflowError({
          message: mandatory.length
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        msg.finish = "error"
        msg.time.completed = Date.now()
        yield* session.updateMessage(msg)
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: msg.error })
        return "stop"
      }
      if (attempt.result !== "continue" || msg.error) return "stop"

      if (input.auto) {
        const continuationUser = Effect.fnUntraced(function* () {
          const newest = yield* latestUser(input.sessionID)
          return newest && newest.id !== parent.info.id ? newest : configUser
        })
        const current = yield* continuationUser()
        const info = yield* provider.getProvider(current.model.providerID)
        if (
          (yield* plugin.trigger(
            "experimental.compaction.autocontinue",
            {
              sessionID: input.sessionID,
              agent: current.agent,
              model: yield* provider.getModel(current.model.providerID, current.model.modelID).pipe(Effect.orDie),
              provider: {
                source: info.source,
                info,
                options: info.options,
              },
              message: current,
              overflow: input.overflow === true,
            },
            { enabled: true },
          )).enabled
        ) {
          // The plugin may await external work while another user arrives.
          const next = yield* continuationUser()
          const continueMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: next.agent,
            model: next.model,
            format:
              next.format?.type === "json_schema"
                ? new SessionV1.OutputFormatJsonSchema(next.format)
                : next.format?.type === "text"
                  ? new SessionV1.OutputFormatText(next.format)
                  : undefined,
            tools: next.tools,
            system: next.system,
          })
          const text =
            (input.overflow
              ? "The previous request exceeded the provider's size limit. Continue from the retained user input and tool results.\n\n"
              : "") +
            "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: continueMsg.id,
            sessionID: input.sessionID,
            type: "text",
            // Internal marker for auto-compaction followups so provider plugins
            // can distinguish them from manual post-compaction user prompts.
            // This is not a stable plugin contract and may change or disappear.
            metadata: { compaction_continue: true, ...(mandatory[0] ? { protected_from: mandatory[0].info.id } : {}) },
            synthetic: true,
            text,
            time: {
              start: Date.now(),
              end: Date.now(),
            },
          })
        }
      }

      yield* events.publish(Event.Compacted, { sessionID: input.sessionID })
      return "continue"
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      auto: boolean
      protectedFrom?: MessageID
      requestUserID?: MessageID
      fixedInputTokens?: number
      overflow?: boolean
    }) {
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
        protected_from: input.protectedFrom,
        request_user_id: input.requestUserID,
        fixed_input_tokens: input.fixedInputTokens,
      })
    })

    return Service.of({
      isOverflow,
      willOverflow,
      prune,
      process: processCompaction,
      create,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Config.node,
    LLM.node,
    Session.node,
    Agent.node,
    Plugin.node,
    SessionProcessor.node,
    Provider.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
  ],
})

export * as SessionCompaction from "./compaction"
