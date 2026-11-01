import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { AgentRun } from "@/agent-management/run"
import { AgentManagement } from "@/agent-management/schema"
import { MessageID, PartID, SessionID } from "@/session/schema"

// Subplan agentmgmt-2-run-state §5.2.1: the pure half of the run record.

const parent = SessionID.make("ses_parent")
const child = SessionID.make("ses_child")
const other = SessionID.make("ses_other")
const now = 1_700_000_000_000
const source: AgentManagement.WakeSource = { kind: "agent", session: parent }

function message(metadata?: Record<string, unknown>): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: { id, role: "user", sessionID: child, agent: "build", model: {} as never, time: { created: now } },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID: child, type: "text", text: "hi", metadata }],
  }
}

describe("AgentRun.begin", () => {
  test("the first run is number 1 with no previous", () => {
    expect(AgentRun.begin(undefined, now, source, true, undefined)).toEqual({
      number: 1,
      started_at: now,
      woken_by: source,
    })
  })

  test("a fresh start over a closed record takes the next number and keeps the end", () => {
    const closed = { number: 3, started_at: 1, woken_by: source, ended_at: 2, outcome: "failed" as const }
    expect(AgentRun.begin(closed, now, source, true, undefined)).toEqual({
      number: 4,
      started_at: now,
      woken_by: source,
      previous: { number: 3, ended_at: 2, outcome: "failed" },
    })
  })

  test("a re-arm over the open record it owns writes nothing: the run continues", () => {
    expect(AgentRun.begin({ number: 3, started_at: 1, woken_by: source }, now, source, false, 3)).toBeUndefined()
  })

  // A re-arm claims only what it owns. One whose open write failed owns
  // nothing, so a leftover it was started over stays a leftover (the second
  // external review, R1); a record gone or carrying another number is not its
  // either.
  test("a re-arm that owns nothing, or not this record, writes nothing and claims nothing", () => {
    const open = { number: 3, started_at: 1, woken_by: source }
    expect(AgentRun.begin(open, now, source, false, undefined)).toBeUndefined()
    expect(AgentRun.begin(open, now, source, false, 2)).toBeUndefined()
    expect(AgentRun.begin(undefined, now, source, false, 3)).toBeUndefined()
    const closed = { ...open, ended_at: 2, outcome: "completed" as const }
    expect(AgentRun.begin(closed, now, source, false, undefined)).toBeUndefined()
  })

  // The continuation window (§6, point 16): onExit closed run N and reported
  // it before the runner saw the late message, so the re-arm is run N+1.
  test("a re-arm over its own closed record is the next run", () => {
    const closed = { number: 3, started_at: 1, woken_by: source, ended_at: 2, outcome: "completed" as const }
    expect(AgentRun.begin(closed, now, source, false, 3)?.number).toBe(4)
  })

  // I5: a leftover open record — the process died or the end write failed —
  // is closed as lost by the run that finds it, so no two runs share a number.
  test("a fresh start over an open record closes it as lost first", () => {
    expect(AgentRun.begin({ number: 3, started_at: 1, woken_by: source }, now, source, true, undefined)).toEqual({
      number: 4,
      started_at: now,
      woken_by: source,
      previous: { number: 3, ended_at: now, outcome: "lost" },
    })
  })
})

describe("AgentRun.end", () => {
  test("closes an open record", () => {
    expect(AgentRun.end({ number: 1, started_at: 1, woken_by: source }, now, "completed")).toEqual({
      number: 1,
      started_at: 1,
      woken_by: source,
      ended_at: now,
      outcome: "completed",
    })
  })

  test("has nothing to close without a record or with a closed one", () => {
    expect(AgentRun.end(undefined, now, "completed")).toBeUndefined()
    const closed = { number: 1, started_at: 1, woken_by: source, ended_at: 2, outcome: "stopped" as const }
    expect(AgentRun.end(closed, now, "completed")).toBeUndefined()
  })
})

describe("AgentRun.outcomeOf", () => {
  test("maps the three exit kinds; lost is never one of them", () => {
    expect(AgentRun.outcomeOf("completed")).toBe("completed")
    expect(AgentRun.outcomeOf("failed")).toBe("failed")
    expect(AgentRun.outcomeOf("cancelled")).toBe("stopped")
  })
})

describe("AgentRun.wakeSource", () => {
  test("rule 1: the first run is woken by the creator, whatever the message says", () => {
    const wake = AgentRun.wakeSource({
      number: 1,
      parent: { id: parent, name: "lead", agent: "build" },
      message: message({ kind: "user_message" }),
    })
    expect(wake).toEqual({ kind: "agent", session: parent, name: "lead", agent: "build" })
  })

  test("rule 2: an agent message or a report names its sender", () => {
    for (const kind of ["agent_message", "agent_notification"]) {
      const wake = AgentRun.wakeSource({
        number: 2,
        parent: { id: parent },
        message: message({ kind, sender: other, sender_name: "cw-1", sender_agent: "explore" }),
      })
      expect(wake).toEqual({ kind: "agent", session: other, name: "cw-1", agent: "explore" })
    }
    // Sender fields are optional and stay absent, not undefined.
    const bare = AgentRun.wakeSource({
      number: 2,
      parent: { id: parent },
      message: message({ kind: "agent_message", sender: other }),
    })
    expect(bare).toEqual({ kind: "agent", session: other })
    expect(Object.keys(bare)).toEqual(["kind", "session"])
    // The sender is part metadata any client may write: one that is not a
    // session id is nobody in particular.
    expect(
      AgentRun.wakeSource({
        number: 2,
        parent: { id: parent },
        message: message({ kind: "agent_message", sender: "nobody" }),
      }),
    ).toEqual({ kind: "system" })
  })

  test("rule 3: the TUI's agent-message route is the user", () => {
    expect(
      AgentRun.wakeSource({ number: 2, parent: { id: parent }, message: message({ kind: "user_message" }) }),
    ).toEqual({
      kind: "user",
    })
  })

  test("rule 4: everything else is the system, including an old report without a sender", () => {
    expect(AgentRun.wakeSource({ number: 2, parent: { id: parent }, message: message() })).toEqual({ kind: "system" })
    expect(AgentRun.wakeSource({ number: 2, parent: { id: parent }, message: undefined })).toEqual({ kind: "system" })
    expect(
      AgentRun.wakeSource({ number: 2, parent: { id: parent }, message: message({ kind: "agent_notification" }) }),
    ).toEqual({ kind: "system" })
  })
})

describe("AgentRun.read", () => {
  test("tolerates a missing, foreign or damaged record", () => {
    expect(AgentRun.read(undefined)).toBeUndefined()
    expect(AgentRun.read({ agentName: "x" })).toBeUndefined()
    expect(AgentRun.read({ agentRun: { number: "one" } })).toBeUndefined()
    const run = { number: 2, started_at: 1, woken_by: { kind: "system" as const } }
    expect(AgentRun.read({ agentRun: run })).toEqual(run)
  })
})

describe("AgentRun.describeSource", () => {
  test("four readings, from the viewer's side; a name is escaped", () => {
    expect(AgentRun.describeSource({ kind: "agent", session: child }, child)).toBe("your message")
    expect(AgentRun.describeSource({ kind: "agent", session: other, name: "cw-1" }, child)).toBe("cw-1")
    expect(AgentRun.describeSource({ kind: "agent", session: other, name: "a]\nb" }, child)).toBe("a\\]\\nb")
    expect(AgentRun.describeSource({ kind: "agent", session: SessionID.make("ses]\nx") }, child)).toBe("ses\\]\\nx")
    expect(AgentRun.describeSource({ kind: "agent", session: other }, child)).toBe(other)
    expect(AgentRun.describeSource({ kind: "user" }, child)).toBe("user")
    expect(AgentRun.describeSource({ kind: "system" }, child)).toBe("system")
  })
})

describe("AgentRun time formats", () => {
  test("formatInstant carries the local offset and round-trips the instant", () => {
    const text = AgentRun.formatInstant(now)
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
    expect(new Date(text).getTime()).toBe(now)
  })

  test("formatClock is the time of day of the same instant", () => {
    const text = AgentRun.formatClock(now)
    expect(text).toMatch(/^\d{2}:\d{2}:\d{2}$/)
    expect(AgentRun.formatInstant(now)).toContain(`T${text}`)
  })
})
