import type { ModelMessage } from "ai"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import type { Session } from "./session"
import type { SessionStatus } from "./status"
import type { SessionID } from "./schema"
import { AgentManagement } from "../agent-management/schema"
import { AgentRun } from "../agent-management/run"
import { AgentStatusProjection } from "../agent-management/status"

/**
 * The step tail: a short block of facts appended at the very end of one
 * provider request and never written to the session history.
 *
 * It sits after every persisted message, so the request prefix shared with the
 * previous step — and the provider's prompt cache over it — is untouched; it is
 * rebuilt for every step, so old copies never pile up in the history.
 * `provider/transform.ts` keeps cache breakpoints off it by the marker below.
 */

/** Provider-options marker that identifies the tail message. */
export const MARKER = { opencode: { tail: true } } as const

/** The tool calls of one step and what they returned, each in emission order. */
export type StepSignature = {
  readonly calls: readonly string[]
  readonly results: readonly string[]
}

/**
 * How many steps in a row repeated the tool calls of the step before them, and
 * how many of those also got the same results. Lives for one run.
 */
export type Repeat = {
  readonly calls: number
  readonly results: number
}

export const NO_REPEAT: Repeat = { calls: 0, results: 0 }

export function signature(parts: readonly SessionV1.Part[]): StepSignature {
  const tools = parts.filter((part): part is SessionV1.ToolPart => part.type === "tool")
  return {
    calls: tools.map((part) => JSON.stringify([part.tool, part.state.input])),
    results: tools.map((part) => JSON.stringify([part.state.status, outcome(part.state)])),
  }
}

/**
 * Compared with the step before: the same calls count one more repeat, and the
 * same calls with the same results count one more on the second counter too;
 * anything different clears the counter it breaks. A step without tool calls
 * is never a repeat.
 */
export function nextRepeat(previous: StepSignature | undefined, current: StepSignature, repeat: Repeat): Repeat {
  if (!previous || current.calls.length === 0 || !same(previous.calls, current.calls)) return NO_REPEAT
  return {
    calls: repeat.calls + 1,
    results: same(previous.results, current.results) ? repeat.results + 1 : 0,
  }
}

/** Facts only: how often the last step repeated the one before it. */
export function renderRepeat(repeat: Repeat): string | undefined {
  if (repeat.calls === 0) return undefined
  const results =
    repeat.results === 0
      ? "the results differed this time."
      : `the results were identical too: ${times(repeat.results)} in a row.`
  return `Your last step repeated the tool calls of the step before it: ${times(repeat.calls)} in a row; ${results}`
}

/** Joins the non-empty sections, or nothing when there is nothing to say. */
export function render(sections: readonly (string | undefined)[]): string | undefined {
  const present = sections.filter((section): section is string => section !== undefined && section.length > 0)
  return present.length === 0 ? undefined : present.join("\n\n")
}

export function message(text: string): ModelMessage {
  return { role: "user", content: [{ type: "text", text }], providerOptions: MARKER }
}

function outcome(state: SessionV1.ToolPart["state"]) {
  if (state.status === "completed") return state.output
  if (state.status === "error") return state.error
  return ""
}

function same(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

function times(count: number) {
  return count === 1 ? "1 time" : `${count} times`
}

// The subagent view (subplan agentmgmt-2-run-state §4.5): a snapshot for the
// model of where it is and what its direct children are doing — the clock, who
// is running, who finished lately. Rebuilt every step, never stored.

/** The ten-minute floor of the view's window. */
export const WINDOW_MS = 10 * 60 * 1000
/** Rows per list; the rest are counted in one trailing line. */
export const LIST_ROWS = 10

/** One direct child as the view reads it: its session row and its projected status. */
export type Child = {
  readonly id: SessionID
  readonly name?: string
  readonly created: number
  readonly running: boolean
  readonly lastStep?: number
  readonly run?: AgentManagement.AgentRun
}

/**
 * Where the window starts: ten minutes back, or the previous step's start
 * when that is earlier, so a child that finished during a long step is seen
 * at least once by the step after it. On a run's first step the previous
 * step's start is the run's start.
 */
export function windowStart(now: number, previousStepStart: number) {
  return Math.min(now - WINDOW_MS, previousStepStart)
}

/** Part 1 of the view: the current time. */
export function renderClock(input: { now: number }) {
  return `Now: ${AgentRun.formatInstant(input.now)}.`
}

/**
 * Step S15: the direct children as the view reads them. One SQL for the rows
 * and the in-memory projection for running and last step; no history, no
 * messages, no depth (expectations §8).
 */
export const collectSubagents = Effect.fn("StepTail.collectSubagents")(function* (input: {
  sessions: Pick<Session.Interface, "children">
  status: Pick<SessionStatus.Interface, "list">
  parentID: SessionID
}) {
  const rows = yield* input.sessions.children(input.parentID)
  // One copy of the projection rather than a lookup effect per child: with
  // hundreds of children the per-call overhead was most of the budget.
  const statuses = yield* input.status.list()
  return rows.map((row): Child => {
    const name = row.metadata?.[AgentManagement.METADATA_AGENT_NAME]
    const run = AgentRun.read(row.metadata)
    const current = statuses.get(row.id)
    return {
      id: row.id,
      ...(typeof name === "string" ? { name } : {}),
      created: row.time.created,
      running: AgentStatusProjection.project(current) === "running",
      ...(current?.at === undefined ? {} : { lastStep: current.at }),
      ...(run ? { run } : {}),
    }
  })
})

/**
 * Step S16, parts 2 and 3 of the view: the overview, who is running and who
 * finished inside the window. The overview counts those same sets before
 * truncation; nothing when both are empty. Rows are facts in a fixed shape —
 * the reader holds the tool descriptions, so no line here tells it what to call.
 */
export function renderSubagents(input: {
  now: number
  children: readonly Child[]
  windowStart: number
  viewer: SessionID
}): string | undefined {
  if (input.children.length === 0) return undefined
  // Longest-running first: those are the easiest to forget and the likeliest
  // to be stuck, so the newest are the ones dropped past the cap.
  const running = input.children
    .filter((child) => child.running)
    .toSorted((a, b) => startOf(a) - startOf(b) || compare(a.id, b.id))
  // Finished inside the window, newest first. A record still open on an idle
  // child is a run cut off by a crash: listed whatever the window, since it
  // has no end time and would otherwise never be seen.
  const finished = input.children
    .flatMap((child) => (child.running || !child.run ? [] : [{ child, run: child.run }]))
    .filter((item) => item.run.ended_at === undefined || item.run.ended_at >= input.windowStart)
    .toSorted((a, b) => endOf(b.run) - endOf(a.run) || compare(a.child.id, b.child.id))
  if (running.length === 0 && finished.length === 0) return undefined
  const lines = [
    `Your subagents: ${running.length + finished.length} direct, ${running.length} running, ${finished.length} idle.`,
  ]
  if (running.length > 0) {
    lines.push("Running now:", ...running.slice(0, LIST_ROWS).map((child) => runningRow(child, input)))
    if (running.length > LIST_ROWS) lines.push(`  … and ${running.length - LIST_ROWS} more running`)
  }
  if (finished.length > 0) {
    const heading =
      input.windowStart === input.now - WINDOW_MS
        ? "Finished in the last 10 minutes, now idle:"
        : `Finished since ${AgentRun.formatClock(input.windowStart)}, now idle:`
    lines.push(heading, ...finished.slice(0, LIST_ROWS).map((item) => finishedRow(item.child, item.run)))
    if (finished.length > LIST_ROWS) lines.push(`  … and ${finished.length - LIST_ROWS} more finished`)
  }
  return lines.join("\n")
}

function startOf(child: Child) {
  return child.run?.started_at ?? child.created
}

function endOf(run: AgentManagement.AgentRun) {
  return run.ended_at ?? run.started_at
}

function compare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}

// Escaped for the same reason a message header is: the name comes from the
// model, and a newline in it would forge a row of its own.
function label(child: Child) {
  return child.name === undefined ? `  ${child.id}  ` : `  ${child.id}  ${AgentManagement.escapeField(child.name)}  `
}

function runningRow(child: Child, input: { windowStart: number; viewer: SessionID }) {
  const last = child.lastStep === undefined ? "" : `, last step ${AgentRun.formatClock(child.lastStep)}`
  // No open record under a running child: its start write is still in flight,
  // failed, or this is the continuation window. Said as agent_send says it.
  if (!child.run || child.run.ended_at !== undefined) {
    return `${label(child)}running (run record not updated yet)${last}`
  }
  const run = child.run
  const since = `run ${run.number} since ${AgentRun.formatClock(run.started_at)} (${AgentRun.describeSource(run.woken_by, input.viewer)})`
  // The run before, when it ended inside the window: the race in #75 is a
  // report arriving after the parent's step began, and this is where it shows.
  const previous =
    run.previous && run.previous.ended_at >= input.windowStart
      ? `; run ${run.previous.number} ended ${AgentRun.formatClock(run.previous.ended_at)} (${run.previous.outcome})`
      : ""
  return `${label(child)}${since}${last}${previous}`
}

function finishedRow(child: Child, run: AgentManagement.AgentRun) {
  if (run.ended_at === undefined) {
    return `${label(child)}run ${run.number} cut off since ${AgentRun.formatClock(run.started_at)} (not yet recorded as lost)`
  }
  return `${label(child)}run ${run.number} ended ${AgentRun.formatClock(run.ended_at)} (${run.outcome})`
}

export * as StepTail from "./step-tail"
