import { describe, expect } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"
import {
  periodicToolCallResponse,
  type EncodedPeriodicToolCall,
  type PeriodicToolCall,
  type PeriodicToolCallFixture,
} from "../../lib/periodic-tool-calls"

const TEST_TIMEOUT_MS = 180_000
const SERVER_READY_TIMEOUT_MS = 45_000
const REFUSED = "Not run: within this one response, the same tool calls have now been repeated three times in a row."

type Sdk = ReturnType<typeof createOpencodeClient>

function call<T>(request: () => Promise<T>, label: string) {
  return Effect.promise(request).pipe(
    Effect.timeoutOrElse({
      duration: "45 seconds",
      orElse: () => Effect.fail(new Error(`timed out waiting for ${label}`)),
    }),
  )
}

function poll<A, E, R>(self: Effect.Effect<A | undefined, E, R>, message: string) {
  return Effect.gen(function* () {
    while (true) {
      const result = yield* self
      if (result !== undefined) return result
      yield* Effect.sleep("100 millis")
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: "60 seconds",
      orElse: () => Effect.fail(new Error(message)),
    }),
  )
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function hasUserText(body: Record<string, unknown>, value: string) {
  if (!Array.isArray(body.messages)) return false
  return body.messages.some((message) => {
    if (!message || typeof message !== "object" || !("role" in message) || message.role !== "user") return false
    return JSON.stringify("content" in message ? message.content : undefined).includes(value)
  })
}

function isTitleInput(body: Record<string, unknown>) {
  return JSON.stringify(body).includes("Generate a title for this conversation")
}

function expectPromptInputs(inputs: Record<string, unknown>[], marker: string, count: number) {
  const relevant = inputs.filter((body) => !isTitleInput(body) && hasUserText(body, marker))
  expect(relevant).toHaveLength(count)
}

function alternatingFixture(idPrefix: string) {
  const input = { pattern: "serve-alternating-shared-never-match" }
  const block = [
    { tool: "glob", input },
    { tool: "grep", input },
  ] satisfies PeriodicToolCall[]
  return periodicToolCallResponse({
    blocks: [block, block, block],
    chunkStyle: "one-per-chunk",
    idPrefix,
  })
}

function listPermissions(sdk: Sdk, directory: string) {
  return call(async () => {
    const result = await sdk.permission.list({ directory })
    if (result.response.status !== 200) {
      throw new Error(`permission list returned HTTP ${result.response.status}`)
    }
    return array(result.data).map(record)
  }, "permission list response")
}

function sessionStatus(sdk: Sdk, directory: string) {
  return call(async () => {
    const result = await sdk.session.status({ directory })
    if (result.response.status !== 200) {
      throw new Error(`session status returned HTTP ${result.response.status}`)
    }
    return record(result.data)
  }, "session status response")
}

function waitForIdle(sdk: Sdk, directory: string, sessionID: string) {
  return poll(
    sessionStatus(sdk, directory).pipe(
      Effect.map((statuses) => (statuses[sessionID] === undefined ? true : undefined)),
    ),
    `timed out waiting for session ${sessionID} to become idle`,
  )
}

function messages(sdk: Sdk, directory: string, sessionID: string) {
  return call(async () => {
    const result = await sdk.session.messages({ sessionID, directory })
    if (result.response.status !== 200) {
      throw new Error(`session messages returned HTTP ${result.response.status}`)
    }
    return result.data
  }, "session messages response")
}

function waitForMessages(
  sdk: Sdk,
  directory: string,
  sessionID: string,
  predicate: (value: unknown) => boolean,
  message: string,
) {
  return poll(
    messages(sdk, directory, sessionID).pipe(Effect.map((value) => (predicate(value) ? value : undefined))),
    message,
  )
}

function toolParts(value: unknown) {
  return array(value)
    .flatMap((message) => array(record(message).parts))
    .map(record)
    .filter((part) => part.type === "tool")
}

function matchingParts(value: unknown, calls: readonly EncodedPeriodicToolCall[]) {
  const ids = new Set(calls.map((item) => item.id))
  return toolParts(value).filter((part) => ids.has(String(part.callID)))
}

function enqueue(
  llm: Parameters<Parameters<typeof cliIt.live>[1]>[0]["llm"],
  prompt: string,
  ...items: Parameters<typeof llm.push>
) {
  return llm.pushMatch(({ body }) => hasUserText(body, prompt) && !isTitleInput(body), ...items)
}

function prompt(sdk: Sdk, sessionID: string, text: string) {
  return call(
    () =>
      sdk.session.promptAsync({
        sessionID,
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text }],
      }),
    "async prompt response",
  )
}

// Fix doc session-fix-step-tail-repeat-and-agents §4.2: a repeat inside one
// response is refused without a permission request. The calls before it run,
// the refused one returns the error, and the run goes on to the model's reply.
function expectRefusedRepeat(value: unknown, fixture: PeriodicToolCallFixture) {
  const parts = matchingParts(value, fixture.calls)
  expect(parts).toHaveLength(fixture.calls.length)
  for (const expected of fixture.calls) {
    const matches = parts.filter((part) => part.callID === expected.id)
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ callID: expected.id, tool: expected.tool, state: { input: expected.input } })
  }
  const unfinished = parts
    .filter((part) => record(part.state).status !== "completed")
    .map((part) => [part.callID, record(part.state).status, record(part.state).error])
  expect(unfinished).toEqual([[fixture.calls.at(-1)?.id, "error", REFUSED]])
}

describe("periodic doom-loop spawned server", () => {
  cliIt.live(
    "refuses each response's repeat without a permission request and finishes both prompts",
    (test) =>
      Effect.gen(function* () {
        const server = yield* test.opencode.serve({ readyTimeoutMs: SERVER_READY_TIMEOUT_MS })
        const sdk = createOpencodeClient({ baseUrl: server.url, directory: test.home })
        const created = yield* call(() => sdk.session.create({ title: "periodic refusal" }), "session creation")
        expect(created.response.status).toBe(200)
        const sessionID = String(record(created.data).id)

        // Each prompt's response gets its own detector, so the second cycle is
        // refused again; a pending ask would block the run and time out here.
        yield* Effect.forEach(["first", "second"], (round) =>
          Effect.gen(function* () {
            const fixture = alternatingFixture(`${round}-call`)
            const text = `serve period-two ${round} prompt`
            const continuation = `${text} completed`
            yield* enqueue(test.llm, text, fixture.item, reply().text(continuation).stop())

            const prompted = yield* prompt(sdk, sessionID, text)
            expect(prompted.response.status).toBe(204)
            const settled = yield* waitForMessages(
              sdk,
              test.home,
              sessionID,
              (value) => JSON.stringify(value).includes(continuation),
              `timed out waiting for the ${round} prompt to finish`,
            )
            yield* waitForIdle(sdk, test.home, sessionID)
            expectRefusedRepeat(settled, fixture)
            expect(yield* listPermissions(sdk, test.home)).toEqual([])
            expectPromptInputs(yield* test.llm.inputs, text, 2)
          }),
        )
        expect(yield* test.llm.pending).toBe(0)
      }),
    TEST_TIMEOUT_MS,
  )
})
