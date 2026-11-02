import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "./schema"
import { Effect, Layer, Context } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"

export const Info = SessionStatusEvent.Info
export type Info = SessionStatusEvent.Info

export const Event = SessionStatusEvent

/**
 * A status as the projection holds it: the wire status plus when it was set,
 * epoch ms. In memory only — the event carries the status alone. `at` is
 * absent for the idle default, which nothing ever set; for a running session
 * it is the start of its last step, because the loop sets busy at every step.
 */
export type Projected = Info & { readonly at?: number }

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Projected>
  readonly list: () => Effect.Effect<Map<SessionID, Projected>>
  readonly set: (sessionID: SessionID, status: Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStatus") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionStatus.state")(() => Effect.succeed(new Map<SessionID, Projected>())),
    )

    const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.get(sessionID) ?? { type: "idle" as const }
    })

    const list = Effect.fn("SessionStatus.list")(function* () {
      return new Map(yield* InstanceState.get(state))
    })

    const set = Effect.fn("SessionStatus.set")(function* (sessionID: SessionID, status: Info) {
      const data = yield* InstanceState.get(state)
      yield* events.publish(Event.Status, { sessionID, status })
      if (status.type === "idle") {
        yield* events.publish(Event.Idle, { sessionID })
        data.delete(sessionID)
        return
      }
      // Step S9: stamped on the way in; the event above carries the status alone.
      data.set(sessionID, { ...status, at: Date.now() })
    })

    return Service.of({ get, list, set })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as SessionStatus from "./status"
