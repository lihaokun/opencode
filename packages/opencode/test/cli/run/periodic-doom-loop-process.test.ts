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

function expectCalls(
  parts: Array<Record<string, unknown>>,
  response: PeriodicToolCallFixture,
  expected: "completed" | "terminal",
) {
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
  const statuses = parts.map((part) => record(part.state).status)
  if (expected === "completed") {
    expect(statuses.every((status) => status === "completed")).toBe(true)
    return
  }
  // AI SDK tool execution is concurrent with permission settlement, so rejection cannot roll back completed calls.
  expect(statuses.every((status) => status === "completed" || status === "error")).toBe(true)
}

function expectAsk(input: {
  readonly fixture: CliFixture
  readonly response: PeriodicToolCallFixture
  readonly prompt: string
  readonly expectedPattern: string
}) {
  return Effect.gen(function* () {
    const continuation = `${input.prompt} continuation must remain queued`
    yield* input.fixture.llm.pushMatch(
      ({ body }) => hasUserText(body, input.prompt) && !isTitleInput(body),
      input.response.item,
      reply().text(continuation).stop(),
    )

    const result = yield* input.fixture.opencode.run(input.prompt, {
      format: "json",
      permission: { doom_loop: "ask" },
    })

    input.fixture.opencode.expectExit(result, 1, input.prompt)
    expect(result.stderr).toContain(`permission requested: doom_loop (${input.expectedPattern}); auto-rejecting`)
    expect(result.stdout).not.toContain(continuation)
    const parts = yield* storedToolParts(input.fixture.opencode, sessionID(result, input.fixture))
    expectCalls(parts, input.response, "terminal")
    expectPromptInputs(yield* input.fixture.llm.inputs, input.prompt, 1)
    expect(yield* input.fixture.llm.pending).toBe(1)
  })
}

function expectContinuation(input: {
  readonly fixture: CliFixture
  readonly response: PeriodicToolCallFixture
  readonly prompt: string
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
      permission: { doom_loop: "ask" },
    })

    input.fixture.opencode.expectExit(result, 0)
    expect(result.stderr).not.toContain("permission requested: doom_loop")
    expect(result.stdout).toContain(continuation)
    const parts = yield* storedToolParts(input.fixture.opencode, sessionID(result, input.fixture))
    expectCalls(parts, input.response, "completed")
    expectPromptInputs(yield* input.fixture.llm.inputs, input.prompt, 2)
    expect(yield* input.fixture.llm.pending).toBe(0)
  })
}

describe("periodic doom-loop spawned CLI", () => {
  cliIt.live(
    "asks after three period-1 repetitions encoded in one batch",
    (test) => {
      const block = globBlock(1)
      return expectAsk({
        fixture: test,
        response: fixture(repeated(block, 3), "all-batched"),
        prompt: "period-one all-batched",
        expectedPattern: "glob",
      })
    },
    TEST_TIMEOUT_MS,
  )

  cliIt.live(
    "asks after three period-2 repetitions encoded one call per chunk",
    (test) => {
      const block = alternatingBlock()
      return expectAsk({
        fixture: test,
        response: fixture(repeated(block, 3), "one-per-chunk"),
        prompt: "period-two one-per-chunk",
        expectedPattern: "grep",
      })
    },
    TEST_TIMEOUT_MS,
  )

  cliIt.live(
    "asks after three period-3 repetitions encoded in pairs",
    (test) => {
      const block = globBlock(3)
      return expectAsk({
        fixture: test,
        response: fixture(repeated(block, 3), "pairs"),
        prompt: "period-three pairs",
        expectedPattern: "glob",
      })
    },
    TEST_TIMEOUT_MS,
  )

  cliIt.live(
    "asks after three period-10 repetitions with sequential argument fragments",
    (test) => {
      const block = globBlock(10)
      return expectAsk({
        fixture: test,
        response: fixture(repeated(block, 3), "fragmented-sequential"),
        prompt: "period-ten fragmented-sequential",
        expectedPattern: "glob",
      })
    },
    TEST_TIMEOUT_MS,
  )

  cliIt.live(
    "asks for an alternating period-2 cycle with starts before reverse fragments",
    (test) => {
      const block = alternatingBlock()
      return expectAsk({
        fixture: test,
        response: fixture(repeated(block, 3), "starts-then-reverse-fragments"),
        prompt: "period-two reverse-fragments",
        expectedPattern: "glob",
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
        expectCalls(parts, response, "completed")
        expectPromptInputs(yield* test.llm.inputs, prompt, 2)
        expect(yield* test.llm.pending).toBe(0)
      }),
    TEST_TIMEOUT_MS,
  )

  cliIt.live(
    "stops a period-2 cycle when doom_loop is denied",
    (test) =>
      Effect.gen(function* () {
        const block = alternatingBlock()
        const response = fixture(repeated(block, 3), "all-batched")
        const prompt = "period-two explicitly-denied"
        const continuation = `${prompt} continuation must remain queued`
        yield* test.llm.pushMatch(
          ({ body }) => hasUserText(body, prompt) && !isTitleInput(body),
          response.item,
          reply().text(continuation).stop(),
        )

        const result = yield* test.opencode.run(prompt, {
          format: "json",
          permission: { doom_loop: "deny" },
        })

        test.opencode.expectExit(result, 1, prompt)
        expect(result.stderr).not.toContain("permission requested: doom_loop")
        expect(result.stdout).not.toContain(continuation)
        expect(result.stdout).toContain("prevents you from using this specific tool call")
        const parts = yield* storedToolParts(test.opencode, sessionID(result, test))
        expectCalls(parts, response, "terminal")
        expectPromptInputs(yield* test.llm.inputs, prompt, 1)
        expect(yield* test.llm.pending).toBe(1)
      }),
    TEST_TIMEOUT_MS,
  )
})
