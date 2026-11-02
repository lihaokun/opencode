import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt, type CliFixture } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"
import {
  periodicToolCallResponse,
  type PeriodicToolCall,
  type PeriodicToolCallChunkStyle,
  type PeriodicToolCallFixture,
} from "../../lib/periodic-tool-calls"

const TEST_TIMEOUT_MS = 180_000
// Fix doc session-fix-step-tail-repeat-and-agents §4.2: the repeat is refused
// inside the response, without a permission request, and the run goes on.
const REFUSED = "Not run: within this one response, the same tool calls have now been repeated three times in a row."

function isTitleInput(body: Record<string, unknown>) {
  return JSON.stringify(body).includes("Generate a title for this conversation")
}

function hasUserText(body: Record<string, unknown>, value: string) {
  if (!Array.isArray(body.messages)) return false
  return body.messages.some((message) => {
    if (!message || typeof message !== "object" || !("role" in message) || message.role !== "user") return false
    return JSON.stringify("content" in message ? message.content : undefined).includes(value)
  })
}

function expectPromptInputs(inputs: Record<string, unknown>[], marker: string, count: number) {
  const relevant = inputs.filter((body) => !isTitleInput(body))
  expect(relevant).toHaveLength(count)
  expect(relevant.every((body) => hasUserText(body, marker))).toBe(true)
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function repeated(block: readonly PeriodicToolCall[], count: number) {
  return Array.from({ length: count }, () => block)
}

function globBlock(period: number) {
  return Array.from({ length: period }, (_, index) => ({
    tool: "glob",
    input: { pattern: `period-${period}-value-${index}` },
  })) satisfies PeriodicToolCall[]
}

function alternatingBlock() {
  const input = { pattern: "alternating-shared-never-match" }
  return [
    { tool: "glob", input },
    { tool: "grep", input },
  ] satisfies PeriodicToolCall[]
}

function fixture(blocks: readonly (readonly PeriodicToolCall[])[], chunkStyle: PeriodicToolCallChunkStyle) {
  return periodicToolCallResponse({ blocks, chunkStyle })
}

function storedToolParts(opencode: CliFixture["opencode"], sessionID: string) {
  return Effect.gen(function* () {
    const escaped = sessionID.replaceAll("'", "''")
    const stored = yield* opencode.spawn([
      "db",
      `select data from part where session_id = '${escaped}'`,
      "--format",
      "json",
    ])
    opencode.expectExit(stored, 0, "query periodic doom-loop parts")
    const rows = JSON.parse(stored.stdout) as Array<{ data?: string }>
    return rows
      .map((row) => JSON.parse(row.data ?? "{}") as Record<string, unknown>)
      .filter((part) => part.type === "tool")
  })
}

function sessionID(result: { stdout: string }, fixture: CliFixture) {
  const events = fixture.opencode.parseJsonEvents(result.stdout)
  const value = events.find((event) => typeof event.sessionID === "string")?.sessionID
  expect(value).toEqual(expect.any(String))
  if (typeof value !== "string") throw new Error("CLI JSON output did not include a session ID")
  return value
}

function expectCalls(parts: Array<Record<string, unknown>>, response: PeriodicToolCallFixture, refusedTool?: string) {
  expect(parts).toHaveLength(response.calls.length)
  for (const call of response.calls) {
    const matches = parts.filter((part) => part.callID === call.id)
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      callID: call.id,
      tool: call.tool,
      state: {
        input: call.input,
      },
    })
  }
  // Everything that did not complete is exactly the refused repeat, if any.
  const unfinished = parts
    .filter((part) => record(part.state).status !== "completed")
    .map((part) => [part.tool, record(part.state).status, record(part.state).error])
  expect(unfinished).toEqual(refusedTool ? [[refusedTool, "error", REFUSED]] : [])
}

// The run always continues: the second request carries the tool results, the
// refusal included, and the model's text ends the run.
function expectContinuation(input: {
  readonly fixture: CliFixture
  readonly response: PeriodicToolCallFixture
  readonly prompt: string
  readonly doomLoop?: "ask" | "allow" | "deny"
  readonly refusedTool?: string
}) {
  return Effect.gen(function* () {
    const continuation = `${input.prompt} completed`
    yield* input.fixture.llm.pushMatch(
      ({ body }) => hasUserText(body, input.prompt) && !isTitleInput(body),
      input.response.item,
      reply().text(continuation).stop(),
    )

    const result = yield* input.fixture.opencode.run(input.prompt, {
      format: "json",
      permission: { doom_loop: input.doomLoop ?? "ask" },
    })

    input.fixture.opencode.expectExit(result, 0)
    expect(result.stderr).not.toContain("permission requested: doom_loop")
    expect(result.stdout).toContain(continuation)
    const parts = yield* storedToolParts(input.fixture.opencode, sessionID(result, input.fixture))
    expectCalls(parts, input.response, input.refusedTool)
    expectPromptInputs(yield* input.fixture.llm.inputs, input.prompt, 2)
    expect(yield* input.fixture.llm.pending).toBe(0)
  })
}

describe("periodic doom-loop spawned CLI", () => {
  cliIt.live(
    "refuses the repeat after three period-1 repetitions encoded in one batch",
    (test) => {
      const block = globBlock(1)
      return expectContinuation({
        fixture: test,
        response: fixture(repeated(block, 3), "all-batched"),
        prompt: "period-one all-batched",
        refusedTool: "glob",
      })
    },
    TEST_TIMEOUT_MS,
  )

  cliIt.live(
    "refuses the repeat after three period-2 repetitions encoded one call per chunk",
    (test) => {
      const block = alternatingBlock()
      return expectContinuation({
        fixture: test,
        response: fixture(repeated(block, 3), "one-per-chunk"),
        prompt: "period-two one-per-chunk",
        refusedTool: "grep",
      })
    },
    TEST_TIMEOUT_MS,
  )

  cliIt.live(
    "refuses the repeat after three period-3 repetitions encoded in pairs",
    (test) => {
      const block = globBlock(3)
      return expectContinuation({
        fixture: test,
        response: fixture(repeated(block, 3), "pairs"),
        prompt: "period-three pairs",
        refusedTool: "glob",
      })
    },
    TEST_TIMEOUT_MS,
  )

  cliIt.live(
    "refuses the repeat after three period-10 repetitions with sequential argument fragments",
    (test) => {
      const block = globBlock(10)
      return expectContinuation({
        fixture: test,
        response: fixture(repeated(block, 3), "fragmented-sequential"),
        prompt: "period-ten fragmented-sequential",
        refusedTool: "glob",
      })
    },
    TEST_TIMEOUT_MS,
  )

  cliIt.live(
    "refuses the repeat in an alternating period-2 cycle with starts before reverse fragments",
    (test) => {
      const block = alternatingBlock()
      return expectContinuation({
        fixture: test,
        response: fixture(repeated(block, 3), "starts-then-reverse-fragments"),
        prompt: "period-two reverse-fragments",
        refusedTool: "glob",
      })
    },
    TEST_TIMEOUT_MS,
  )

  cliIt.live(
    "does not ask after two fragmented period-2 repetitions",
    (test) => {
      const block = alternatingBlock()
      return expectContinuation({
        fixture: test,
        response: fixture(repeated(block, 2), "starts-then-reverse-fragments"),
        prompt: "period-two fragmented-only-two-repetitions",
      })
    },
    TEST_TIMEOUT_MS,
  )

  cliIt.live(
    "does not ask when the third period-3 repetition is a near miss",
    (test) => {
      const block = globBlock(3)
      const changed = block.map((call, index) =>
        index === block.length - 1 ? { tool: call.tool, input: { pattern: "period-three-changed-final-value" } } : call,
      )
      return expectContinuation({
        fixture: test,
        response: fixture([block, block, changed, block.slice(0, 1)], "one-per-chunk"),
        prompt: "period-three near-miss-reset",
      })
    },
    TEST_TIMEOUT_MS,
  )

  cliIt.live(
    "does not ask for a period-11 cycle beyond the configured bound",
    (test) => {
      const block = globBlock(11)
      return expectContinuation({
        fixture: test,
        response: fixture(repeated(block, 3), "one-per-chunk"),
        prompt: "period-eleven out-of-bound",
      })
    },
    TEST_TIMEOUT_MS,
  )

  cliIt.live(
    "continues a period-2 cycle when doom_loop is allowed",
    (test) =>
      Effect.gen(function* () {
        const block = alternatingBlock()
        const response = fixture(repeated(block, 3), "all-batched")
        const prompt = "period-two explicitly-allowed"
        const continuation = `${prompt} completed`
        yield* test.llm.pushMatch(
          ({ body }) => hasUserText(body, prompt) && !isTitleInput(body),
          response.item,
          reply().text(continuation).stop(),
        )

        const result = yield* test.opencode.run(prompt, {
          format: "json",
          permission: { doom_loop: "allow" },
        })

        test.opencode.expectExit(result, 0)
        expect(result.stderr).not.toContain("permission requested: doom_loop")
        expect(result.stdout).toContain(continuation)
        const parts = yield* storedToolParts(test.opencode, sessionID(result, test))
        expectCalls(parts, response)
        expectPromptInputs(yield* test.llm.inputs, prompt, 2)
        expect(yield* test.llm.pending).toBe(0)
      }),
    TEST_TIMEOUT_MS,
  )

  cliIt.live(
    "refuses a period-2 repeat without asking when doom_loop is denied, and continues",
    (test) =>
      expectContinuation({
        fixture: test,
        response: fixture(repeated(alternatingBlock(), 3), "all-batched"),
        prompt: "period-two explicitly-denied",
        doomLoop: "deny",
        refusedTool: "grep",
      }),
    TEST_TIMEOUT_MS,
  )
})
