import { Option, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { AgentDelegation } from "./delegation"
import { AgentManagement } from "./schema"
import { SessionID } from "../session/schema"

// The run record of a subagent (subplan agentmgmt-2-run-state §5.2.1): pure
// functions over AgentManagement.AgentRun. SessionPrompt.loop reads the record
// off the session, calls these, and writes the result back; nothing here
// touches a store or a clock.

const decode = Schema.decodeUnknownOption(AgentManagement.AgentRun)

/**
 * The record in a session's metadata, or undefined when it is absent or
 * unreadable — a session from before the record existed, or a damaged row.
 */
export function read(metadata: Record<string, unknown> | undefined) {
  return Option.getOrUndefined(decode(metadata?.[AgentManagement.METADATA_AGENT_RUN]))
}

/**
 * The record a run opens with, or undefined when nothing is to be written.
 *
 * `fresh` is the work's first execution; a re-arm re-executes the same work
 * (H9). A re-arm over an open record continues that run. A re-arm over a
 * closed one is the continuation window: onExit already ended run N and
 * reported it, so what follows is run N+1 (§6, point 16). A fresh start over
 * an open record is a leftover — the process died or the end write failed —
 * and it is closed as lost here, so the two runs never share a number (I5).
 */
export function begin(
  previous: AgentManagement.AgentRun | undefined,
  now: number,
  wokenBy: AgentManagement.WakeSource,
  fresh: boolean,
): AgentManagement.AgentRun | undefined {
  if (!fresh && previous && previous.ended_at === undefined) return undefined
  const last =
    previous === undefined
      ? undefined
      : (ended(previous) ?? { number: previous.number, ended_at: now, outcome: "lost" as const })
  return {
    number: (previous?.number ?? 0) + 1,
    started_at: now,
    woken_by: wokenBy,
    ...(last ? { previous: last } : {}),
  }
}

/** The end of a closed record, or undefined while it is open. */
export function ended(run: AgentManagement.AgentRun): AgentManagement.RunEnd | undefined {
  if (run.ended_at === undefined || run.outcome === undefined) return undefined
  return { number: run.number, ended_at: run.ended_at, outcome: run.outcome }
}

/**
 * The record closed with this outcome, or undefined when there is nothing open
 * to close: the open write failed, and begin accounts for that at the next
 * start.
 */
export function end(
  current: AgentManagement.AgentRun | undefined,
  now: number,
  outcome: AgentManagement.RunOutcome,
): AgentManagement.AgentRun | undefined {
  if (!current || current.ended_at !== undefined) return undefined
  return { ...current, ended_at: now, outcome }
}

/** classifyExit's three kinds as the record's outcomes; `lost` only comes from begin. */
export function outcomeOf(kind: AgentDelegation.Outcome["kind"]): AgentManagement.RunOutcome {
  return kind === "cancelled" ? "stopped" : kind
}

/**
 * Who woke a run (§4.2). The first run's wake is the creator: its task prompt
 * carries no marker, and the parent is who sent it (H11). After that the
 * latest message decides by its first text part's metadata: a message from an
 * agent or a report from a child names its sender; the TUI's agent-message
 * route marks the human; everything else — a plain prompt, the automatic
 * continue after compaction, a message from before the markers existed — is
 * the system.
 */
export function wakeSource(input: {
  number: number
  parent: { id: SessionID; name?: string; agent?: string }
  message: SessionV1.WithParts | undefined
}): AgentManagement.WakeSource {
  if (input.number === 1) return agentSource(input.parent.id, input.parent.name, input.parent.agent)
  const meta = input.message?.parts.find((part): part is SessionV1.TextPart => part.type === "text")?.metadata
  const kind = meta?.kind
  const fromAgent =
    kind === AgentManagement.AGENT_MESSAGE_METADATA_KIND || kind === AgentManagement.NOTIFICATION_METADATA_KIND
  if (fromAgent && typeof meta?.sender === "string") {
    return agentSource(SessionID.make(meta.sender), text(meta.sender_name), text(meta.sender_agent))
  }
  if (kind === AgentManagement.USER_MESSAGE_METADATA_KIND) return { kind: "user" }
  return { kind: "system" }
}

function agentSource(session: SessionID, name: string | undefined, agent: string | undefined) {
  return {
    kind: "agent" as const,
    session,
    ...(name === undefined ? {} : { name }),
    ...(agent === undefined ? {} : { agent }),
  }
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

/**
 * ISO 8601 with the local offset, `2026-10-20T03:41:18+08:00`. The step tail,
 * the reports, agent_send and agent_status all take their full timestamps from
 * here (expectations §10).
 */
export function formatInstant(ms: number) {
  const date = new Date(ms)
  const offset = -date.getTimezoneOffset()
  const sign = offset < 0 ? "-" : "+"
  const abs = Math.abs(offset)
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${day}T${formatClock(ms)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** `HH:MM:SS`, local time: the short form the step tail's lists and the summary suffix use. */
export function formatClock(ms: number) {
  const date = new Date(ms)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function pad(value: number) {
  return String(value).padStart(2, "0")
}

/** The wake source as the session `viewer` reads it (§4.2). */
export function describeSource(source: AgentManagement.WakeSource, viewer: SessionID) {
  if (source.kind === "user") return "user"
  if (source.kind === "system") return "system"
  if (source.session === viewer) return "your message"
  return source.name ?? source.session ?? "agent"
}

export * as AgentRun from "./run"
