import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Layer, Context, Scope } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent } from "../agent/agent"
import { Session } from "../session/session"
import { AgentManagement } from "./schema"

export interface Interface {
  readonly deliver: (input: {
    message: AgentManagement.InboxMessage
    ops: AgentManagement.AgentPromptOps
  }) => Effect.Effect<AgentManagement.Accepted, AgentManagement.AgentNotFound | AgentManagement.SelfDelivery>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentInbox") {}

// The field encoding lives with the other shared definitions (it is used by
// the pure run and step-tail modules too) and stays reachable here, where
// every message header has always taken it from.
export { escapeField } from "./schema"

/**
 * The header line for a message from the human, sent through the TUI's
 * agent-message endpoint. Deliberately field-free: there is no sender session
 * to name, nothing model-sourced to escape, and no reply instruction — the
 * human is watching this transcript and the target answers in place. The TUI
 * keeps its own copy of the literal for its tests (expectations §10).
 */
export const USER_MESSAGE_HEADER = "[Message from user]"

/**
 * The system-written prefix. The reply instruction always names the sender's
 * session_id rather than its name: a name is a weak alias that may be missing or
 * ambiguous, while a session_id works from anywhere.
 */
export function render(message: AgentManagement.AgentMessage) {
  const name = message.sender_name === undefined ? undefined : AgentManagement.escapeField(message.sender_name)
  const agent = AgentManagement.escapeField(message.sender_agent ?? "agent")
  const who = name ? `${name} (${agent}, ${message.sender})` : `${agent} (${message.sender})`
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
      message: AgentManagement.InboxMessage
      ops: AgentManagement.AgentPromptOps
    }) {
      const message = input.message
      if (message.kind === "agent" && message.message.sender === message.message.target) {
        return yield* new AgentManagement.SelfDelivery({ target: message.message.target })
      }

      // No neighbour check and no same-tree check: a message transfers no
      // authority, and the target always acts under its own Session's
      // permissions.
      const targetID = message.message.target
      // Step P1: target lookup — the only failure path, mapped to BadRequest by
      // the HTTP layer.
      const target = yield* sessions
        .get(targetID)
        .pipe(Effect.mapError(() => new AgentManagement.AgentNotFound({ session_id: targetID })))

      // Step P2: all three identity fields are read from the target and passed
      // explicitly. createUserMessage resolves `input.model ?? agent's model ??
      // session's current model` and falls back to the default agent when
      // `agent` is omitted, then writes the result back with setAgentModel — so
      // leaving any of them out rewrites and persists the target's identity.
      // Both sender kinds resolve here: this block is the single owner of the
      // rule that a delivered message never changes who the target is (I1).
      const agent = target.agent ?? (yield* agents.defaultInfo()).name
      const model = target.model ? { providerID: target.model.providerID, modelID: target.model.id } : undefined
      // setAgentModel stores `variant ?? "default"`, so echoing "default" back
      // would turn "no variant chosen" into "default chosen" on the first round
      // trip.
      const variant = target.model?.variant === "default" ? undefined : target.model?.variant

      // Step P3: only the rendered parts differ by sender kind. The agent
      // header is built from model-sourced fields and goes through render()'s
      // escaping; the user header is a fixed string — no fields, so no
      // escaping, and no reply instruction, because the human is watching this
      // transcript and the target answers in place.
      // Step S13: each carries its marker in metadata — the kind the TUI will
      // read (#73), and for an agent the sender the run record reads. The text
      // is the same as before the markers (I10).
      const parts =
        message.kind === "agent"
          ? [{ type: "text" as const, text: render(message.message), metadata: senderMetadata(message.message) }]
          : [
              {
                type: "text" as const,
                text: USER_MESSAGE_HEADER,
                metadata: { kind: AgentManagement.USER_MESSAGE_METADATA_KIND },
              },
              ...message.message.parts,
            ]

      // Step P4: deliverAsync, not prompt — it does the fork *and* the switch
      // to the target's instance. Doing the fork here instead left the target
      // running inside the sender's instance, against the sender's directory,
      // config and permissions.
      //
      // Forking is still required for the reason it always was — prompt returns
      // `loop(...)` unless noReply is set, so awaiting it blocks until the
      // target finishes its whole turn, and noReply is no escape either since it
      // persists the message without ever running the loop.
      yield* input.ops.deliverAsync({
        sessionID: targetID,
        agent,
        model,
        variant,
        parts,
      })

      return { target: targetID }
    })

    return Service.of({ deliver })
  }),
)

/** The marker and the sender on an agent message's text part (subplan agentmgmt-2-run-state §4.3). */
function senderMetadata(message: AgentManagement.AgentMessage) {
  return {
    kind: AgentManagement.AGENT_MESSAGE_METADATA_KIND,
    sender: message.sender,
    ...(message.sender_name === undefined ? {} : { sender_name: message.sender_name }),
    ...(message.sender_agent === undefined ? {} : { sender_agent: message.sender_agent }),
  }
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Session.node, Agent.node, EventV2Bridge.node],
})

export * as AgentInbox from "./inbox"
