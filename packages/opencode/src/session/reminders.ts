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
import { Permission } from "@/permission"
import { AGENT_LIST_TOOL_ID } from "@/tool/agent"
import { AgentTree } from "@/agent-management/tree"
import { AgentInbox } from "@/agent-management/inbox"
import { AgentManagement } from "@/agent-management/schema"
import { AgentStatusProjection } from "@/agent-management/status"

/** Marks a roster part so a later turn can find the most recent one. */
export const AGENT_ROSTER_SENTINEL = "<!-- opencode:subagents -->"

/**
 * Tells an Agent what its direct children are doing.
 *
 * Edge-triggered, delivered at a turn boundary. The trigger is either the start
 * of a turn — the last user message has no assistant message after it yet — or a
 * compaction with no roster after it. Anything that stops a parent and later
 * brings it back, a cancellation, an API failure, an interrupt, a restart,
 * shows up as one of those, so there is no list of causes to keep complete, and
 * the judgement is made by the side that wakes up rather than recorded by the
 * side that is about to die. A flag written on the way out is not written at all
 * when the process is killed.
 *
 * The criterion is deliberately wider than that intent: an ordinary new turn
 * matches it too. What narrows it down is the comparison below — a roster is
 * written only when it differs from the most recent one still visible — so the
 * effective rule is "say something when the children's collective state has
 * changed since the last time we said anything".
 *
 * Written to the transcript rather than rebuilt per step, and evaluated once per
 * turn rather than once per step, which is the same point from two sides: the
 * part is appended to a user message that has not been sent to the provider yet,
 * so it costs no cache. Rebuilding it on a later step of the same turn would
 * rewrite a message already sent and invalidate everything after it.
 *
 * The count of these grows with the number of observed state changes, and over
 * a long session there is no bound on it — a child can be woken through
 * agent_send again and again. Old entries are left where they are: removing one
 * would mean rewriting history, which is the cache cost this design exists to
 * avoid. They leave the visible context through compaction, and the heading says
 * "at this point" because agent_list is the authority, not a line from four
 * turns ago.
 */
export const applyAgentRoster = Effect.fn("SessionReminders.applyAgentRoster")(function* (input: {
  messages: SessionV1.WithParts[]
  session: Session.Info
  agent?: Agent.Info
}) {
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages

  // Evaluated before this step's assistant message exists, so "nothing after the
  // last user message" is true on the first step of a turn and false on every
  // later one. By position rather than by timestamp, which two messages can
  // share. After a compaction filterCompacted puts a continue-user message
  // last, so that reads as a turn boundary here too.
  const lastUser = input.messages.lastIndexOf(userMessage)
  const turnStart = !input.messages.slice(lastUser + 1).some((msg) => msg.info.role === "assistant")

  // Compaction replaces the start notice and the completion notice with a
  // summary, so the roster has to come back even mid-turn. Only until one does:
  // otherwise every step for the rest of the session would qualify, which is
  // the per-step evaluation this exists to get away from.
  const flat = input.messages.flatMap((msg) => msg.parts)
  const compaction = flat.findLastIndex((part) => part.type === "compaction")
  const roster = flat.findLastIndex((part) => part.type === "text" && part.text.startsWith(AGENT_ROSTER_SENTINEL))
  const compacted = compaction >= 0 && roster < compaction

  if (!turnStart && !compacted) return input.messages

  const tree = yield* AgentTree.Service
  const projection = yield* AgentStatusProjection.Service
  const sessions = yield* Session.Service

  const depth = yield* tree.callerDepth(input.session.id).pipe(Effect.orElseSucceed(() => 0))
  const children = yield* tree.children(input.session.id, depth + 1)
  // Most subagents have none, and they get nothing at all.
  if (children.length === 0) return input.messages

  // A roster and agent_list expose the same thing, so a session denied the tool
  // is not handed the list by another route. Merged the way tools.ts merges it,
  // since a user writes the rule on the agent while the session carries what was
  // derived for this run.
  const ruleset = Permission.merge(input.agent?.permission ?? [], input.session.permission ?? [])
  if (Permission.evaluate(AGENT_LIST_TOOL_ID, "*", ruleset).action === "deny") return input.messages

  // Running only. The old list was every child the session had ever started,
  // which is what "at this point" promised and what made it grow without
  // bound: on one real session it reached 133 rows of which 6 were running,
  // was re-injected whenever any of the other 127 changed state, and came to
  // 58% of the text in the recent window. What a reader needs is who is
  // working alongside it now; the full picture is agent_list's job, and
  // reaching anyone at all is agent_send's.
  const live = yield* Effect.forEach(children, (child) =>
    projection.of(child.session_id).pipe(Effect.map((status) => (status === "running" ? child : undefined))),
  ).pipe(Effect.map((items) => items.filter((item) => item !== undefined)))

  // Newest first, then capped. A session that fans out widely would otherwise
  // trade one unbounded list for a slightly shorter unbounded list.
  const ordered = live.toSorted((a, b) => b.time_created - a.time_created)
  const shown = ordered.slice(0, AgentManagement.ROSTER_MAX_ROWS)
  const rows = shown.map((child) => {
    // Escaped for the same reason a message header is: the name and the title
    // both come from the model, and a newline in either would forge a row of
    // its own. The title carries the agent type already -- it is built as
    // `<description> (@<type> subagent)` -- so there is no separate type here.
    const name = child.name ? `${AgentInbox.escapeField(child.name)}  ` : ""
    return `  ${child.session_id}  ${name}— ${AgentInbox.escapeField(child.title)}`
  })
  const omitted = ordered.length - shown.length
  // Facts only, no tool directions: the model has the tool descriptions, and a
  // line that says what to call would be repeated at the start of every turn.
  // When nothing is running the roster still says so in one line rather than
  // vanishing -- a parent whose children have all finished keeps the one fact
  // that it has them, and the count tells it how many it has to account for.
  const finished = children.length - live.length
  const text = [
    AGENT_ROSTER_SENTINEL,
    rows.length === 0
      ? `Your subagents working right now: none (${finished} finished).`
      : "Your subagents working right now:",
    ...rows,
    ...(omitted > 0 ? [`  ${omitted} more are running.`] : []),
  ].join("\n")

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
