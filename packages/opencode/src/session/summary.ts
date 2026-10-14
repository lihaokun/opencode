import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Schema, Semaphore } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Snapshot } from "@/snapshot"
import { Session } from "./session"
import { SessionID, MessageID } from "./schema"
import { Config } from "@/config/config"

function unquoteGitPath(input: string) {
  if (!input.startsWith('"')) return input
  if (!input.endsWith('"')) return input
  const body = input.slice(1, -1)
  const bytes: number[] = []

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0))
      continue
    }

    const next = body[i + 1]
    if (!next) {
      bytes.push("\\".charCodeAt(0))
      continue
    }

    if (next >= "0" && next <= "7") {
      const chunk = body.slice(i + 1, i + 4)
      const match = chunk.match(/^[0-7]{1,3}/)
      if (!match) {
        bytes.push(next.charCodeAt(0))
        i++
        continue
      }
      bytes.push(parseInt(match[0], 8))
      i += match[0].length
      continue
    }

    const escaped =
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next === "v"
                  ? "\v"
                  : next === "\\" || next === '"'
                    ? next
                    : undefined

    bytes.push((escaped ?? next).charCodeAt(0))
    i++
  }

  return Buffer.from(bytes).toString()
}

/** The user message and the assistant messages that answered it. */
function turn(messages: SessionV1.WithParts[], messageID: MessageID) {
  return messages.filter(
    (m) => m.info.id === messageID || (m.info.role === "assistant" && m.info.parentID === messageID),
  )
}

/** git C-quotes paths with quotes, backslashes or control characters; callers get the real name. */
function unquote(item: Snapshot.FileDiff): Snapshot.FileDiff {
  if (item.file === undefined) return item
  const file = unquoteGitPath(item.file)
  return file === item.file ? item : { ...item, file }
}

/** Same files, counts and statuses, and neither side carries a patch. */
function sameStat(stored: readonly Snapshot.FileDiff[], fresh: readonly Snapshot.FileDiff[]) {
  return (
    stored.length === fresh.length &&
    stored.every((row, i) => {
      const next = fresh[i]!
      return (
        row.patch === undefined &&
        row.file === next.file &&
        row.additions === next.additions &&
        row.deletions === next.deletions &&
        row.status === next.status
      )
    })
  )
}

export interface Interface {
  readonly summarize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
  readonly diff: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Snapshot.FileDiff[]>
  readonly computeDiff: (input: { messages: SessionV1.WithParts[] }) => Effect.Effect<Snapshot.FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSummary") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snapshot = yield* Snapshot.Service
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service

    // The two snapshot hashes a turn's diff is computed from: the first
    // step-start and the last step-finish among the turn's messages.
    const snapshots = (messages: SessionV1.WithParts[]) => {
      const parts = messages.flatMap((item) => item.parts)
      return {
        from: parts.filter((part) => part.type === "step-start").find((part) => part.snapshot)?.snapshot,
        to: parts.filter((part) => part.type === "step-finish").findLast((part) => part.snapshot)?.snapshot,
      }
    }

    const computeDiff = Effect.fn("SessionSummary.computeDiff")(function* (input: { messages: SessionV1.WithParts[] }) {
      const { from, to } = snapshots(input.messages)
      if (from && to) return yield* snapshot.diffFull(from, to)
      return []
    })

    const summarizeOnce = Effect.fn("SessionSummary.summarizeOnce")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      if ((yield* config.get()).snapshot === false) {
        yield* sessions.setSummary({ sessionID: input.sessionID, summary: { additions: 0, deletions: 0, files: 0 } })
        yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: [] })
        return
      }
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      if (!all.length) return

      const messages = turn(all, input.messageID)
      const target = messages.find((m) => m.info.id === input.messageID)
      if (!target || target.info.role !== "user") return
      // Names and counts only. The patch is derived from the two snapshot
      // hashes the step parts already carry, and is computed when a client asks
      // for it (see diff below). Storing it put every changed file's full text
      // into the message, and the durable message.updated event copied that
      // again on every write of the message.
      const { from, to } = snapshots(messages)
      // A failed comparison writes nothing: the next step's summary retries, and
      // an empty list written here would read as "this turn changed nothing".
      const compare: Effect.Effect<Snapshot.FileDiff[], Snapshot.DiffError> =
        from && to ? snapshot.diffStat(from, to) : Effect.succeed([])
      const stat = yield* compare.pipe(
        Effect.catchTag("SnapshotDiffError", (error) =>
          Effect.logWarning("summary skipped: snapshot diff failed", {
            sessionID: input.sessionID,
            messageID: input.messageID,
            error: error.message,
          }).pipe(Effect.as(undefined)),
        ),
      )
      if (!stat) return
      const diffs = stat.map(unquote)
      // Every write is a durable event; nothing new to say means no write. A
      // message never summarised is not one summarised with no changes: its
      // first write, even of an empty list, is what resets the session's counts
      // and clears the sidebar after a turn that changed nothing.
      const stored = target.info.summary?.diffs
      if (stored && sameStat(stored, diffs)) return
      target.info.summary = { ...target.info.summary, diffs }
      yield* sessions.updateMessage(target.info)
      yield* sessions.setSummary({
        sessionID: input.sessionID,
        summary: {
          files: diffs.length,
          additions: diffs.reduce((sum, item) => sum + item.additions, 0),
          deletions: diffs.reduce((sum, item) => sum + item.deletions, 0),
        },
      })
      yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
    })

    // Several summaries for one message can be in flight at once: the processor
    // schedules one per step and releases them together when the attempt ends,
    // and the next run's first step schedules one more. One runs at a time per
    // message, one more may wait, and any further caller leaves — the waiting
    // one reads the same final state it would have.
    const inflight = new Map<MessageID, { gate: Semaphore.Semaphore; waiting: number }>()
    const summarize = Effect.fn("SessionSummary.summarize")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      const entry = inflight.get(input.messageID) ?? { gate: Semaphore.makeUnsafe(1), waiting: 0 }
      inflight.set(input.messageID, entry)
      if (entry.waiting > 0) return
      entry.waiting += 1
      yield* entry.gate.withPermits(1)(
        Effect.suspend(() => {
          entry.waiting -= 1
          return summarizeOnce(input)
        }),
      )
      if (entry.waiting === 0 && inflight.get(input.messageID) === entry) inflight.delete(input.messageID)
    })

    const diff = Effect.fn("SessionSummary.diff")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      // No message named means the most recent turn, as the sidebar's file list
      // asks on opening a session: what that turn stored, names and counts,
      // without computing a patch nobody asked for.
      if (!input.messageID) {
        const latest = all.findLast((item) => item.info.role === "user")
        return latest?.info.role === "user" ? (latest.info.summary?.diffs ?? []).map(unquote) : []
      }
      const message = all.find((item) => item.info.id === input.messageID)
      if (!message || message.info.role !== "user") return []
      const stored = message.info.summary?.diffs ?? []
      // Patches are computed here, on request, from the turn's snapshot hashes.
      // A message that still carries stored patches predates that and keeps
      // them: its snapshot objects may be gone by now. A turn with no hashes
      // (snapshots off, or a message from before they were recorded) has only
      // what it stores.
      const diffs = stored.some((item) => item.patch !== undefined)
        ? stored
        : yield* computeDiff({ messages: turn(all, input.messageID) })
      return (diffs.length ? diffs : stored).map(unquote)
    })

    return Service.of({ summarize, diff, computeDiff })
  }),
)

export const DiffInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
})
export type DiffInput = Schema.Schema.Type<typeof DiffInput>

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Session.node, Snapshot.node, EventV2Bridge.node, Config.node],
})

export * as SessionSummary from "./summary"
