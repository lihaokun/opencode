// Fix doc session-fix-tail-zero-running.md, end to end: the report says a
// resumed parent kept describing agents that had all finished, because the
// step tail went silent once every child had left the window. The in-process
// tests seed child sessions directly in the store; this one drives the real
// chain through a spawned `opencode run` — the agent tool creating the child
// with its parent id, the child's run record closed on completion, the
// report waking the parent — and then resumes the session in a fresh process
// after the child's run has left the window.
import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { AgentManagement } from "@/agent-management/schema"
import { reply } from "../../lib/llm-server"
import { cliIt } from "../../lib/cli-process"

const TEST_TIMEOUT_MS = 120_000

// `opencode db` hands back JSON columns as raw text.
const StoredSession = Schema.Struct({
  id: Schema.optional(Schema.String),
  parent_id: Schema.optional(Schema.NullOr(Schema.String)),
  metadata: Schema.optional(Schema.NullOr(Schema.String)),
})
const StoredPart = Schema.Struct({
  data: Schema.optional(Schema.String),
})
const Sessions = Schema.Array(StoredSession)
const Parts = Schema.Array(StoredPart)

const StoredRun = Schema.Struct({
  number: Schema.Number,
  ended_at: Schema.Number,
  outcome: Schema.String,
})

function bodyIncludes(body: Record<string, unknown>, value: string) {
  return JSON.stringify(body).includes(value)
}

function isTitleInput(body: Record<string, unknown>) {
  return bodyIncludes(body, "Generate a title for this conversation")
}

function hasUserText(body: Record<string, unknown>, value: string) {
  if (!Array.isArray(body.messages)) return false
  return body.messages.some((message) => {
    if (!message || typeof message !== "object" || !("role" in message) || message.role !== "user") return false
    return JSON.stringify("content" in message ? message.content : undefined).includes(value)
  })
}

/** The text of the last user message, which is where the step tail rides. */
function lastUserText(body: Record<string, unknown>) {
  const last = Array.isArray(body.messages) ? body.messages.at(-1) : undefined
  return last?.role === "user" && typeof last.content === "string" ? last.content : undefined
}

describe("step tail after every subagent has finished (spawned CLI)", () => {
  cliIt.concurrent(
    "a parent resumed after its agents left the window is told none are running",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        const parentPrompt = "delegate then wait for the report"
        const childPrompt = "finish the delegated lookup"
        const resumedPrompt = "pick up where we left off"
        const clockTail = /^Now: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\.\n\n/

        // 1. The parent delegates; the child answers; the report wakes the
        //    parent for a second run inside the same `opencode run`.
        yield* llm.pushMatch(
          ({ body }) => hasUserText(body, parentPrompt) && !bodyIncludes(body, "Agent completed"),
          reply().tool("agent", {
            description: "look it up",
            prompt: childPrompt,
            subagent_type: "general",
            cwd: ".",
          }),
        )
        yield* llm.pushMatch(
          ({ body }) => hasUserText(body, childPrompt),
          reply().text("the thing is in src/auth.ts").stop(),
        )
        yield* llm.pushMatch(
          ({ body }) => bodyIncludes(body, "Agent completed"),
          reply().text("nothing left to wait for").stop(),
        )

        const first = yield* opencode.run(parentPrompt, {
          format: "json",
          extraArgs: ["--dangerously-skip-permissions"],
        })
        opencode.expectExit(first, 0)
        const sessionID = opencode.parseJsonEvents(first.stdout).find((event) => typeof event.sessionID === "string")!
          .sessionID as string

        // 2. The child is a real row under this parent with a closed run
        //    record — what the view reads, written by the real tool.
        const children = yield* opencode.spawn([
          "db",
          `select id, parent_id, metadata from session where parent_id = '${sessionID.replaceAll("'", "''")}'`,
          "--format",
          "json",
        ])
        opencode.expectExit(children, 0, "query child sessions")
        const rows = Schema.decodeUnknownSync(Sessions)(JSON.parse(children.stdout))
        expect(rows).toHaveLength(1)
        const childID = rows[0]!.id!
        expect(rows[0]!.parent_id).toBe(sessionID)
        const run = Schema.decodeUnknownSync(StoredRun)(
          (JSON.parse(rows[0]!.metadata ?? "{}") as Record<string, unknown>)[AgentManagement.METADATA_AGENT_RUN],
        )
        expect(run.number).toBe(1)
        expect(run.outcome).toBe("completed")

        // 3. While the finished run is still inside the window, the woken
        //    parent's tail lists it: one child, idle, not running.
        const woken = (yield* llm.inputs)
          .filter((body) => !isTitleInput(body) && bodyIncludes(body, "Agent completed"))
          .at(-1)!
        expect(lastUserText(woken)).toContain("Your subagents: 1 direct, 0 running, 1 idle.")
        expect(lastUserText(woken)).toContain(`${childID}  run 1 ended `)

        // 4. The hours between that run and the resume, as a clock jump: the
        //    same child row, its run moved past the ten-minute window.
        const ended = Date.now() - 11 * 60_000
        const rewind = yield* opencode.spawn([
          "db",
          `update session set metadata = json_set(metadata, '$.${AgentManagement.METADATA_AGENT_RUN}.started_at', ${
            ended - 60_000
          }, '$.${AgentManagement.METADATA_AGENT_RUN}.ended_at', ${ended}) where id = '${childID.replaceAll("'", "''")}'`,
          "--format",
          "json",
        ])
        opencode.expectExit(rewind, 0, "rewind the child's run")

        // 5. A fresh process resumes the session. Nothing is running and the
        //    finished row is gone from the window, so the view is the zero
        //    running line under the clock — not silence.
        yield* llm.reset
        yield* llm.text("picked up")
        const second = yield* opencode.run(resumedPrompt, {
          format: "json",
          extraArgs: ["--dangerously-skip-permissions", "--session", sessionID],
        })
        opencode.expectExit(second, 0)

        const resumed = (yield* llm.inputs).filter((body) => !isTitleInput(body))
        expect(resumed).toHaveLength(1)
        const tail = lastUserText(resumed[0]!)!
        expect(tail).toMatch(clockTail)
        expect(tail).toBe(`${tail.split("\n\n")[0]}\n\nYour subagents: 0 running.`)
        expect(tail).not.toContain(childID)

        // 6. The tail never lands in the history, in either process.
        const stored = yield* opencode.spawn([
          "db",
          `select data from part where session_id = '${sessionID.replaceAll("'", "''")}'`,
          "--format",
          "json",
        ])
        opencode.expectExit(stored, 0, "query parent parts")
        const texts = Schema.decodeUnknownSync(Parts)(JSON.parse(stored.stdout)).map((part) => part.data ?? "")
        expect(texts.length).toBeGreaterThan(0)
        expect(texts.some((text) => text.includes("Your subagents:"))).toBe(false)
        expect(texts.some((text) => text.includes("Now: "))).toBe(false)

        expect(yield* llm.pending).toBe(0)
      }),
    TEST_TIMEOUT_MS,
  )
})
