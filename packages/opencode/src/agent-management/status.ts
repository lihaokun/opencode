import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context } from "effect"
import { SessionStatus } from "../session/status"
import { SessionID } from "../session/schema"
import { AgentManagement } from "./schema"

export interface Interface {
  readonly of: (sessionID: SessionID) => Effect.Effect<AgentManagement.AgentStatus>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentStatusProjection") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service

    const of = Effect.fn("AgentStatusProjection.of")(function* (sessionID: SessionID) {
      // SessionStatus.Info is exactly busy | retry | idle, so the branch is
      // exhaustive. `retry` is backoff between attempts, which is still an
      // unfinished execution.
      //
      // Deliberately not BackgroundJob: an Agent resumed through agent_send may
      // be running with no job at all, and agent_list and the roster have to
      // read the same truth.
      const info = yield* status.get(sessionID)
      return info.type === "busy" || info.type === "retry"
        ? ("running" as AgentManagement.AgentStatus)
        : ("idle" as AgentManagement.AgentStatus)
    })

    return Service.of({ of })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [SessionStatus.node] })

export * as AgentStatusProjection from "./status"
