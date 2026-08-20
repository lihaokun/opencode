import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Snapshot } from "../snapshot"
import { Storage } from "@/storage/storage"
import { Session } from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionRunState } from "./run-state"
import { SessionSummary } from "./summary"

export const RevertInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: Schema.optional(PartID),
})
export type RevertInput = Schema.Schema.Type<typeof RevertInput>

export interface Interface {
  readonly revert: (input: RevertInput) => Effect.Effect<Session.Info, Session.BusyError>
  readonly unrevert: (input: { sessionID: SessionID }) => Effect.Effect<Session.Info, Session.BusyError>
  readonly cleanup: (session: Session.Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRevert") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snap = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const events = yield* EventV2Bridge.Service
    const summary = yield* SessionSummary.Service
    const state = yield* SessionRunState.Service

    const revert = Effect.fn("SessionRevert.revert")(function* (input: RevertInput) {
      yield* state.assertNotBusy(input.sessionID)
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      let lastUser: SessionV1.User | undefined
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)

      let rev: Session.Info["revert"]
      const patches: Snapshot.Patch[] = []
      for (const msg of all) {
        if (msg.info.role === "user") lastUser = msg.info
        const remaining = []
        for (const part of msg.parts) {
          if (rev) {
            if (part.type === "patch") patches.push(part)
            continue
          }

          if (!rev) {
            if ((msg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
              const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
              const message = !partID && lastUser ? lastUser : msg.info
              rev = {
                messageID: message.id,
                messageTimeCreated: message.time.created,
                partID,
              }
            }
            remaining.push(part)
          }
        }
      }

      if (!rev) return session
      if (rev.messageTimeCreated === undefined) return session

      const partID = rev.partID
      const partBoundary = partID
        ? (yield* sessions.partChronology({ sessionID: input.sessionID, messageID: rev.messageID })).find(
            (part) => part.id === partID,
          )
        : undefined
      if (partID && !partBoundary) return session
      const marker: RevertBoundary = {
        ...rev,
        messageTimeCreated: rev.messageTimeCreated,
        ...(partBoundary && { partTimeCreated: partBoundary.timeCreated }),
      }

      marker.snapshot = session.revert?.snapshot ?? (yield* snap.track())
      if (session.revert?.snapshot) yield* snap.restore(session.revert.snapshot)
      yield* snap.revert(patches)
      if (marker.snapshot) marker.diff = yield* snap.diff(marker.snapshot)
      const range = all.filter((msg) => compareMessageBoundary(msg.info, marker) >= 0)
      const diffs = yield* summary.computeDiff({ messages: range })
      yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
      yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
      yield* sessions.setRevert({
        sessionID: input.sessionID,
        revert: marker,
        summary: {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        },
      })
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const unrevert = Effect.fn("SessionRevert.unrevert")(function* (input: { sessionID: SessionID }) {
      yield* Effect.logInfo("unreverting", { sessionID: input.sessionID })
      yield* state.assertNotBusy(input.sessionID)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (!session.revert) return session
      if (session.revert.snapshot) yield* snap.restore(session.revert.snapshot)
      yield* sessions.clearRevert(input.sessionID)
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const cleanup = Effect.fn("SessionRevert.cleanup")(function* (session: Session.Info) {
      if (!session.revert) return
      const current =
        session.revert.messageTimeCreated === undefined ? yield* sessions.get(session.id).pipe(Effect.orDie) : session
      if (!current.revert) return
      if (current.revert.messageTimeCreated === undefined) return
      const sessionID = current.id
      const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const marker: RevertBoundary = {
        ...current.revert,
        messageTimeCreated: current.revert.messageTimeCreated,
      }
      const remove = msgs.filter((msg) => {
        const order = compareMessageBoundary(msg.info, marker)
        return marker.partID ? order > 0 : order >= 0
      })
      for (const msg of remove) {
        yield* sessions.removeMessage({ sessionID, messageID: msg.info.id })
      }
      const partID = marker.partID
      const partTimeCreated = marker.partTimeCreated
      const target = partID ? msgs.find((msg) => msg.info.id === marker.messageID) : undefined
      if (partID && partTimeCreated !== undefined && target) {
        const parts = yield* sessions.partChronology({ sessionID, messageID: target.info.id })
        const removeParts = parts.filter(
          (part) => part.timeCreated > partTimeCreated || (part.timeCreated === partTimeCreated && part.id >= partID),
        )
        for (const part of removeParts) {
          yield* sessions.removePart({ sessionID, messageID: target.info.id, partID: part.id })
        }
      }
      yield* sessions.clearRevert(sessionID)
    })

    return Service.of({ revert, unrevert, cleanup })
  }),
)

type RevertBoundary = NonNullable<Session.Info["revert"]> & { messageTimeCreated: number }

function compareMessageBoundary(info: SessionV1.Info, marker: RevertBoundary) {
  if (info.time.created < marker.messageTimeCreated) return -1
  if (info.time.created > marker.messageTimeCreated) return 1
  if (info.id < marker.messageID) return -1
  if (info.id > marker.messageID) return 1
  return 0
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Session.node, Snapshot.node, Storage.node, EventV2Bridge.node, SessionSummary.node, SessionRunState.node],
})

export * as SessionRevert from "./revert"
