import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Layer, Context, Scope } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent } from "../agent/agent"
import { Session } from "../session/session"
import { AgentManagement } from "./schema"

export interface Interface {
  readonly deliver: (input: {
    message: AgentManagement.AgentMessage
    ops: AgentManagement.AgentPromptOps
  }) => Effect.Effect<
    AgentManagement.Accepted,
    AgentManagement.AgentNotFound | AgentManagement.SelfDelivery
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentInbox") {}

/**
 * The system-written prefix. The reply instruction always names the sender's
 * session_id rather than its name: a name is a weak alias that may be missing or
 * ambiguous, while a session_id works from anywhere.
 */
export function render(message: AgentManagement.AgentMessage) {
  const who = message.sender_name
    ? `${message.sender_name} (${message.sender_agent ?? "agent"}, ${message.sender})`
    : `${message.sender_agent ?? "agent"} (${message.sender})`
  return [
    `[Agent message from ${who}]`,
    `To reply, use agent_send(target="${message.sender}", message="<your reply>").`,
    "",
    message.body,
  ].join("\n")
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const events = yield* EventV2Bridge.Service
    const scope = yield* Scope.Scope

    const deliver = Effect.fn("AgentInbox.deliver")(function* (input: {
      message: AgentManagement.AgentMessage
      ops: AgentManagement.AgentPromptOps
    }) {
      const message = input.message
      if (message.sender === message.target) {
        return yield* new AgentManagement.SelfDelivery({ target: message.target })
      }

      // No neighbour check and no same-tree check: a message transfers no
      // authority, and the target always acts under its own Session's
      // permissions.
      const target = yield* sessions
        .get(message.target)
        .pipe(Effect.mapError(() => new AgentManagement.AgentNotFound({ session_id: message.target })))

      // All three identity fields are read from the target and passed
      // explicitly. createUserMessage resolves `input.model ?? agent's model ??
      // session's current model` and falls back to the default agent when
      // `agent` is omitted, then writes the result back with setAgentModel — so
      // leaving any of them out rewrites and persists the target's identity.
      const agent = target.agent ?? (yield* agents.defaultInfo()).name
      const model = target.model
        ? { providerID: target.model.providerID, modelID: target.model.id }
        : undefined
      // setAgentModel stores `variant ?? "default"`, so echoing "default" back
      // would turn "no variant chosen" into "default chosen" on the first round
      // trip.
      const variant = target.model?.variant === "default" ? undefined : target.model?.variant

      yield* input.ops
        .prompt({
          sessionID: target.id,
          agent,
          model,
          variant,
          parts: [{ type: "text", text: render(message) }],
        })
        .pipe(
          // Must be caught inside the fork, or the failure escapes as a defect.
          // Mirrors what the prompt_async handler does.
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logError("agent message delivery failed", { sessionID: target.id, cause })
              yield* events.publish(Session.Event.Error, {
                sessionID: target.id,
                error: new NamedError.Unknown({ message: Cause.pretty(cause) }).toObject(),
              })
            }),
          ),
          // Must fork. prompt returns `loop(...)` unless noReply is set, so
          // awaiting it blocks until the target finishes its whole turn, which
          // would make a one-way message a synchronous call. noReply is not an
          // escape either: it persists the message without ever running the
          // loop, so an idle target would never start.
          Effect.forkIn(scope, { startImmediately: true }),
        )

      return { target: target.id }
    })

    return Service.of({ deliver })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Session.node, Agent.node, EventV2Bridge.node],
})

export * as AgentInbox from "./inbox"
