import { Schema } from "effect"
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

export * as AgentManagement from "./schema"
