import { Effect, Schema } from "effect"
import { PositiveInt } from "@opencode-ai/core/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { SessionPrompt } from "../session/prompt"
import { SessionID } from "../session/schema"

/**
 * Whether an Agent has an active execution right now.
 *
 * Deliberately two-valued: an execution's outcome (completed / failed /
 * cancelled) is delivered through the notification channel when it happens, so
 * the roster only answers "is it still running". Mirrors Claude Code's
 * ListAgents, which reports busy / idle and nothing else.
 */
export type AgentStatus = "running" | "idle"

/**
 * Makes a model-supplied string safe to interpolate into a system-written line:
 * a message header's fields, a row of agent_list, a line of the step tail.
 *
 * A name and an agent type both come from the model, and both land inside the
 * first line of a message. Left alone, a name containing `]` and a newline ends
 * that line early and starts whatever it likes on the next one — a second
 * message header, for instance.
 *
 * Encoding, not stripping: stripping renders `a\nb` and `ab` the same, so two
 * different agents become indistinguishable. And the backslash has to go first,
 * or a real newline encodes to `\n` and collides with a name that literally
 * contained those two characters, which loses the same property by a longer
 * route.
 *
 * What this guarantees is about the header's fields, not about the whole
 * message: a body is free to contain anything, `[Agent message from …`
 * included, because the boundary is the first line and the first line is built
 * entirely from encoded fields.
 */
export function escapeField(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")
    .replaceAll("\t", "\\t")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
}

/**
 * How many Agents the neighbour snapshot will name. (The roster that shared
 * this cap is retired; the step tail's view has its own, StepTail.LIST_ROWS.)
 *
 * The list exists so a reader knows it has company and who that is; enumerating
 * everyone is agent_list's job and reaching anyone is agent_send's. Ten keeps a
 * widely fanned-out session from trading one unbounded list for a longer one,
 * and sits at the same order of magnitude as the task prompt it travels with.
 */
export const ROSTER_MAX_ROWS = 10

/** Where an Agent's suggested working directory came from. */
export type WorkdirSource = "generated_git_worktree" | "generated_empty_workspace" | "provided_cwd"

export interface AgentWorkdir {
  path: string
  source: WorkdirSource
  /**
   * Always false in V1. The runtime cwd is not switched per Session: file tools
   * resolve relative paths against the instance directory and shell defaults to
   * it, so this path is a suggestion carried in the Agent's initial prompt.
   */
  enforced: false
  /**
   * Why this is not the workspace that would normally be prepared, in words
   * meant for the person reading the tool's output. Absent when nothing needs
   * explaining, which is the usual case.
   *
   * Deliberately not another `WorkdirSource`: that value decides which opening
   * instruction the subagent receives, and a workspace that fell back here
   * needs exactly the instruction an empty one already gets. A separate value
   * would have to be collapsed back into the old one at its only reader.
   */
  note?: string
}

export type AgentRelation = "self" | "parent" | "child" | "sibling"

/**
 * Everything about an Agent that can be read from the Session store.
 *
 * Status is absent on purpose: it is not in AgentTree's observed domain, so
 * returning an AgentInfo with a blank or guessed status would claim something
 * the module cannot know. The tools layer asks the status projection and
 * assembles the full AgentInfo.
 */
export interface AgentSkeleton {
  session_id: SessionID
  parent_id: SessionID | undefined
  name: string | undefined
  agent_type: string | undefined
  title: string
  depth: number
  relation: AgentRelation
  time_created: number
  workdir: AgentWorkdir | undefined
  /** The run record, read off the same row; absent for a session that never ran or is nobody's subagent. */
  run?: AgentRun
}

export interface AgentInfo extends AgentSkeleton {
  status: AgentStatus
}

export interface AgentNeighborhood {
  caller: SessionID
  members: AgentSkeleton[]
}

/** Session metadata keys this feature owns. */
export const METADATA_AGENT_NAME = "agentName"
export const METADATA_AGENT_WORKDIR = "agentWorkdir"
/**
 * The description the creator gave. The session title carries it too, with a
 * " (@type subagent)" suffix; the run-end notice needs it bare, since the
 * summary built from it is what the TUI shows.
 */
export const METADATA_AGENT_DESCRIPTION = "agentDescription"
/**
 * Whether the parent is told each time this agent's run ends. Written at
 * creation and never changed: it is the scope of one delegation, which is
 * exactly one session. A command subtask's child is false — its creator waits
 * on the job itself. Read by SessionPrompt, which owns the run loop.
 */
export const METADATA_AGENT_NOTIFY = "agentNotify"

/**
 * TextPart.metadata.kind marking a run-end notification — the synthetic
 * message SessionPrompt writes to the parent each time a subagent's run ends.
 * The TUI renders one line from `summary` and never parses the model-facing
 * text, so this literal is the only UI-facing contract that notification
 * carries. The TUI cannot import it (part metadata is a free-form record on
 * the SDK side, nothing is generated for it), so it keeps its own copy; the
 * two are held together by contract-audit expectations §10 and fixture tests
 * on both sides.
 */
export const NOTIFICATION_METADATA_KIND = "agent_notification"

/**
 * TextPart.metadata.kind of the user message the run loop writes when the
 * experimental.session.stop hook blocks a stop: the plugin's reason, which the
 * model reads as its next instruction. Synthetic, so the TUI hides it today
 * (issue #90 renders it from this kind).
 */
export const STOP_HOOK_METADATA_KIND = "stop_hook"

/**
 * TextPart.metadata.kind of a message from another agent — agent_send traffic
 * and the cancellation notice — with the sender alongside it: `sender`
 * (SessionID), `sender_name?`, `sender_agent?`. The model-facing text is
 * unchanged; the TUI reads the kind (#73) and the run record reads the sender.
 */
export const AGENT_MESSAGE_METADATA_KIND = "agent_message"

/**
 * TextPart.metadata.kind of the header line a human's message gets when it
 * arrives through the TUI's agent-message route. No fields: there is no sender
 * session.
 */
export const USER_MESSAGE_METADATA_KIND = "user_message"

/**
 * Every part kind this feature writes. The TUI holds its own copy of these
 * literals (it cannot import this file); the two are held together by fixture
 * tests on both sides.
 */
export const PART_KINDS = {
  agent_notification: NOTIFICATION_METADATA_KIND,
  stop_hook: STOP_HOOK_METADATA_KIND,
  agent_message: AGENT_MESSAGE_METADATA_KIND,
  user_message: USER_MESSAGE_METADATA_KIND,
} as const

/**
 * Session metadata key of the run record (subplan agentmgmt-2-run-state §4.1):
 * a subagent's current run and the end of the one before it. Only
 * SessionPrompt.loop writes it, at run start and run end; the agent tools, the
 * step tail and the run-end report read it. Readers tolerate its absence —
 * sessions from before it existed, and an HTTP session.update that replaced
 * the metadata wholesale.
 */
export const METADATA_AGENT_RUN = "agentRun"

export const RUN_OUTCOMES = ["completed", "failed", "stopped", "lost"] as const
export type RunOutcome = (typeof RUN_OUTCOMES)[number]
export const WAKE_KINDS = ["agent", "user", "system"] as const

/** Who woke a run. `session` is present exactly when `kind` is "agent". */
export const WakeSource = Schema.Struct({
  kind: Schema.Literals(WAKE_KINDS),
  session: Schema.optional(SessionID),
  name: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
})
export type WakeSource = typeof WakeSource.Type

/** The end of a run: what the record keeps of the one before the current. */
export const RunEnd = Schema.Struct({
  number: PositiveInt,
  ended_at: Schema.Finite,
  outcome: Schema.Literals(RUN_OUTCOMES),
})
export type RunEnd = typeof RunEnd.Type

/**
 * `ended_at` and `outcome` are present together or not at all; `lost` is only
 * ever written when a new run finds the record still open (the process died or
 * the end write failed), and no report corresponds to it.
 */
export const AgentRun = Schema.Struct({
  number: PositiveInt,
  started_at: Schema.Finite,
  woken_by: WakeSource,
  ended_at: Schema.optional(Schema.Finite),
  outcome: Schema.optional(Schema.Literals(RUN_OUTCOMES)),
  previous: Schema.optional(RunEnd),
})
export type AgentRun = typeof AgentRun.Type

/**
 * Instance names must not be mistakable for a SessionID, because target
 * resolution short-circuits on this prefix before doing any name lookup.
 */
export const SESSION_ID_PREFIX = "ses"

export class AgentNotFound extends Schema.TaggedErrorClass<AgentNotFound>()("AgentNotFound", {
  session_id: Schema.String,
}) {
  override get message() {
    return `No Agent found for session ${this.session_id}.`
  }
}

export class AgentTypeNotFound extends Schema.TaggedErrorClass<AgentTypeNotFound>()("AgentTypeNotFound", {
  subagent_type: Schema.String,
  available: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Unknown agent type "${this.subagent_type}". Available: ${this.available.join(", ")}.`
  }
}

export class AgentNameConflict extends Schema.TaggedErrorClass<AgentNameConflict>()("AgentNameConflict", {
  name: Schema.String,
  reason: Schema.Literals(["taken", "reserved_prefix"]),
}) {
  override get message() {
    return this.reason === "reserved_prefix"
      ? `The name "${this.name}" starts with the reserved prefix "${SESSION_ID_PREFIX}". Choose a different name or omit it.`
      : `The name "${this.name}" is already used by another Agent in this tree. Choose a different name or omit it.`
  }
}

export class NotAChild extends Schema.TaggedErrorClass<NotAChild>()("NotAChild", {
  caller: Schema.String,
  target: Schema.String,
}) {
  override get message() {
    return `Session ${this.target} is not a direct child of this Agent. You can only stop Agents you spawned yourself.`
  }
}

export class SelfDelivery extends Schema.TaggedErrorClass<SelfDelivery>()("SelfDelivery", {
  target: Schema.String,
}) {
  override get message() {
    return `Cannot send a message to yourself.`
  }
}

export class DepthLimitReached extends Schema.TaggedErrorClass<DepthLimitReached>()("DepthLimitReached", {
  depth: Schema.Number,
  limit: Schema.Number,
}) {
  override get message() {
    return `Nesting limit reached: this Agent is at depth ${this.depth} and the limit is ${this.limit}. It cannot spawn further Agents.`
  }
}

/**
 * Name resolution failed. `matches` empty means nothing matched; more than one
 * means the name is ambiguous, which is a reachable state because instance
 * names are weak aliases with no uniqueness guarantee.
 */
export class TargetNotResolved extends Schema.TaggedErrorClass<TargetNotResolved>()("TargetNotResolved", {
  value: Schema.String,
  matches: Schema.Array(Schema.String),
}) {
  override get message() {
    if (this.matches.length === 0) return `No Agent named "${this.value}" is addressable from here.`
    return `The name "${this.value}" matches ${this.matches.length} Agents (${this.matches.join(", ")}). Use a session_id instead.`
  }
}

/**
 * Preparing the working directory failed. Guarantees no Session was created, no
 * prompt was delivered and no Agent was started — but not that the filesystem is
 * clean, so `paths` carries whatever may have been left behind.
 */
export class WorktreeUnavailable extends Schema.TaggedErrorClass<WorktreeUnavailable>()("WorktreeUnavailable", {
  reason: Schema.String,
  paths: Schema.Array(Schema.String),
}) {
  override get message() {
    const left = this.paths.length > 0 ? ` Possible leftovers: ${this.paths.join(", ")}.` : ""
    return `Could not prepare a working directory: ${this.reason}.${left}`
  }
}

/**
 * The slice of SessionPrompt this feature needs, injected by the tool layer the
 * way the task tool already receives it. Keeps the mechanism modules from
 * importing SessionPrompt at runtime.
 */
export interface AgentPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
  /**
   * Asynchronous delivery, routing included — see SessionPrompt.Interface.
   *
   * It lives on this injected interface rather than being imported, because
   * SessionPrompt reaches AgentInbox through the tool registry. Importing back
   * would close the cycle; this indirection is what keeps the graph acyclic.
   */
  deliverAsync(input: SessionPrompt.PromptInput): Effect.Effect<void>
}

/**
 * A message from one Agent to another. Only ever carries agent_send traffic and
 * the single cancellation notice; a new Agent's initial task keeps its parts
 * structure and does not come through here.
 */
export interface AgentMessage {
  target: SessionID
  sender: SessionID
  sender_name: string | undefined
  sender_agent: string | undefined
  body: string
}

/**
 * A delivery into an Agent's inbox, tagged by sender kind. "agent" is agent_send
 * traffic and the single cancellation notice — messages from another session,
 * whose fields land in the rendered header and are escaped accordingly. "user"
 * is a message from the human through the TUI: no sender session exists, the
 * header is a fixed string with nothing to escape, and the body travels as
 * parts so file attachments get the same treatment as a normal prompt.
 *
 * Both kinds flow through one identity resolution — the target's own
 * agent/model/variant — which is why they share a single deliver entry.
 */
export type InboxMessage =
  | { kind: "agent"; message: AgentMessage }
  | { kind: "user"; message: { target: SessionID; parts: SessionPrompt.PromptInput["parts"] } }

/**
 * As strong as the existing HTTP 204: the asynchronous request was accepted and
 * scheduled. Not that the message is persisted, was handled, will be handled, or
 * was answered.
 */
export interface Accepted {
  target: SessionID
}

export interface StopOutcome {
  /**
   * Members a stop was performed on. Not "transitioned from running": cancel on
   * an idle session is a silent success, and reading status first does not help
   * because the target can finish in between.
   */
  stopped: SessionID[]
  failed: { session_id: SessionID; reason: string }[]
}

export * as AgentManagement from "./schema"
