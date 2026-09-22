import { Effect, Schema } from "effect"
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
 * TextPart.metadata.kind marking a delegation outcome notification — the
 * synthetic message inject() writes to the caller when a background
 * delegation settles. The TUI renders one line from `summary` and never
 * parses the model-facing text, so this literal is the only UI-facing
 * contract that notification carries. The TUI cannot import it (part
 * metadata is a free-form record on the SDK side, nothing is generated for
 * it), so it keeps its own copy; the two are held together by contract-audit
 * expectations §10 and fixture tests on both sides.
 */
export const NOTIFICATION_METADATA_KIND = "agent_notification"

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
