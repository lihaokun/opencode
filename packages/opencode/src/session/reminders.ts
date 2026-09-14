import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"
import { AgentTree } from "@/agent-management/tree"
import { AgentStatusProjection } from "@/agent-management/status"

/** Marks a roster part so the next turn can find the most recent one. */
export const AGENT_ROSTER_SENTINEL = "<!-- opencode:subagents -->"

/**
 * Keeps an Agent aware of its direct children.
 *
 * Written to the transcript rather than rebuilt each turn. A non-persisted
 * reminder hangs off the last user message, which does not change across the
 * steps of one turn — so regenerating it rewrites a message that has already
 * been sent and invalidates the cache from that point on, including everything
 * the earlier steps produced. Persisted, it is byte-stable, and appearing once
 * is enough because it stays in history.
 *
 * Emitted only when it differs from the most recent one still visible. The
 * comparison runs against the post-compaction view the loop passes in, so
 * compaction re-emits it without a special case — same rule as a first spawn or
 * a status change.
 */
export const applyAgentRoster = Effect.fn("SessionReminders.applyAgentRoster")(function* (input: {
  messages: SessionV1.WithParts[]
  session: Session.Info
}) {
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages

  const tree = yield* AgentTree.Service
  const projection = yield* AgentStatusProjection.Service
  const sessions = yield* Session.Service

  const depth = yield* tree.callerDepth(input.session.id).pipe(Effect.orElseSucceed(() => 0))
  const children = yield* tree.children(input.session.id, depth + 1)
  // Most subagents have none, and they get nothing at all.
  if (children.length === 0) return input.messages

  const rendered = yield* Effect.forEach(children, (child) =>
    projection.of(child.session_id).pipe(
      Effect.map((status) => {
        const label = child.name ? `${child.name} (${child.agent_type ?? "agent"}, ${status})` : `${child.agent_type ?? "agent"} (${status})`
        return `${child.session_id} ${label}`
      }),
    ),
  )
  const text = [AGENT_ROSTER_SENTINEL, `Your subagents: ${rendered.join(" · ")}`].join("\n")

  const previous = input.messages
    .flatMap((msg) => msg.parts)
    .findLast((part) => part.type === "text" && part.text.startsWith(AGENT_ROSTER_SENTINEL))
  if (previous?.type === "text" && previous.text === text) return input.messages

  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text,
    synthetic: true,
  })
  userMessage.parts.push(part)
  return input.messages
})

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  const flags = yield* RuntimeFlags.Service
  const fsys = yield* FSUtil.Service
  const sessions = yield* Session.Service
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages

  if (!flags.experimentalPlanMode) {
    if (input.agent.name === "plan") {
      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: PROMPT_PLAN,
        synthetic: true,
      })
    }
    const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
    if (wasPlan && input.agent.name === "build") {
      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: BUILD_SWITCH,
        synthetic: true,
      })
    }
    return input.messages
  }

  const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
  if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
    const ctx = yield* InstanceState.context
    const plan = Session.plan(input.session, ctx)
    const exists = yield* fsys.existsSafe(plan)
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: exists
        ? `${BUILD_SWITCH}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it`
        : BUILD_SWITCH,
      synthetic: true,
    })
    userMessage.parts.push(part)
    return input.messages
  }

  if (input.agent.name !== "plan" || assistantMessage?.info.agent === "plan") return input.messages

  const ctx = yield* InstanceState.context
  const plan = Session.plan(input.session, ctx)
  const exists = yield* fsys.existsSafe(plan)
  if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text: PLAN_MODE.replace("${planInfo}", () =>
      exists
        ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.`
        : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
    ),
    synthetic: true,
  })
  userMessage.parts.push(part)
  return input.messages
})

export * as SessionReminders from "./reminders"
