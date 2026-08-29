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

function waitForDoomLoopPermission(sdk: Sdk, directory: string, sessionID: string) {
  return poll(
    listPermissions(sdk, directory).pipe(
      Effect.map((items) => items.find((item) => item.permission === "doom_loop" && item.sessionID === sessionID)),
    ),
    `timed out waiting for doom_loop permission for session ${sessionID}`,
  )
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

function callsMatch(value: unknown, fixture: PeriodicToolCallFixture, status: string) {
  const parts = matchingParts(value, fixture.calls)
  if (parts.length !== fixture.calls.length) return false
  return fixture.calls.every((expected) => {
    const matches = parts.filter((part) => part.callID === expected.id)
    return (
      matches.length === 1 &&
      matches[0]?.tool === expected.tool &&
      record(matches[0]?.state).status === status &&
      JSON.stringify(record(matches[0]?.state).input) === JSON.stringify(expected.input)
    )
  })
}

function expectCalls(value: unknown, fixture: PeriodicToolCallFixture, status: string) {
  const parts = matchingParts(value, fixture.calls)
  expect(parts).toHaveLength(fixture.calls.length)
  for (const expected of fixture.calls) {
    const matches = parts.filter((part) => part.callID === expected.id)
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      callID: expected.id,
      tool: expected.tool,
      state: {
        status,
        input: expected.input,
      },
    })
  }
}

function hasAssistantError(value: unknown) {
  return array(value).some((message) => {
    const info = record(record(message).info)
    return info.role === "assistant" && info.error !== undefined
  })
}

function rejectedCallsMatch(value: unknown, fixture: PeriodicToolCallFixture) {
  const parts = matchingParts(value, fixture.calls)
  if (parts.length !== fixture.calls.length) return false
  return fixture.calls.every((expected) => {
    const matches = parts.filter((part) => part.callID === expected.id)
    if (matches.length !== 1 || matches[0]?.tool !== expected.tool) return false
    const state = record(matches[0]?.state)
    if (JSON.stringify(state.input) !== JSON.stringify(expected.input)) return false
    return state.status === "completed" || state.status === "error"
  })
}

function expectRejectedCalls(value: unknown, fixture: PeriodicToolCallFixture) {
  const parts = matchingParts(value, fixture.calls)
  expect(parts).toHaveLength(fixture.calls.length)
  for (const expected of fixture.calls) {
    const matches = parts.filter((part) => part.callID === expected.id)
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      callID: expected.id,
      tool: expected.tool,
      state: { input: expected.input },
    })
    expect(["completed", "error"]).toContain(String(record(matches[0]?.state).status))
  }
}

function expectPendingCall(value: unknown, expected: EncodedPeriodicToolCall) {
  const matches = toolParts(value).filter((part) => part.callID === expected.id)
  expect(matches).toHaveLength(1)
  expect(matches[0]).toMatchObject({
    callID: expected.id,
    tool: expected.tool,
    state: {
      status: "running",
      input: expected.input,
    },
  })
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

function replyPermission(sdk: Sdk, directory: string, requestID: string, decision: "once" | "reject") {
  return call(() => sdk.permission.reply({ requestID, directory, reply: decision }), `${decision} permission reply`)
}

function expectPermission(input: {
  readonly pending: Record<string, unknown>
  readonly sessionID: string
  readonly trigger: EncodedPeriodicToolCall
}) {
  expect(input.pending).toMatchObject({
    sessionID: input.sessionID,
    permission: "doom_loop",
    patterns: [input.trigger.tool],
    metadata: {
      tool: input.trigger.tool,
      input: input.trigger.input,
    },
    always: [input.trigger.tool],
  })
  expect(typeof input.pending.id).toBe("string")
  expect(String(input.pending.id).length).toBeGreaterThan(0)
}

describe("periodic doom-loop spawned server permissions", () => {
  cliIt.live(
    "continues after once and asks again for the next periodic cycle",
    (test) =>
      Effect.gen(function* () {
        const first = alternatingFixture("once-first-call")
        const firstPrompt = "serve period-two once reply"
        const firstContinuation = `${firstPrompt} completed`
        yield* enqueue(test.llm, firstPrompt, first.item, reply().text(firstContinuation).stop())

        const server = yield* test.opencode.serve({ readyTimeoutMs: SERVER_READY_TIMEOUT_MS })
        const sdk = createOpencodeClient({ baseUrl: server.url, directory: test.home })
        const created = yield* call(() => sdk.session.create({ title: "periodic once" }), "session creation")
        expect(created.response.status).toBe(200)
        const sessionID = String(record(created.data).id)

        const prompted = yield* prompt(sdk, sessionID, firstPrompt)
        expect(prompted.response.status).toBe(204)

        const firstPending = yield* waitForDoomLoopPermission(sdk, test.home, sessionID)
        const firstTrigger = first.calls.at(-1)
        if (!firstTrigger) throw new Error("periodic fixture did not contain a trigger call")
        expectPermission({ pending: firstPending, sessionID, trigger: firstTrigger })
        expect(record((yield* sessionStatus(sdk, test.home))[sessionID]).type).toBe("busy")
        const beforeFirstReply = yield* waitForMessages(
          sdk,
          test.home,
          sessionID,
          (value) => toolParts(value).some((part) => part.callID === firstTrigger.id),
          "timed out waiting for the threshold call before the once reply",
        )
        expectPendingCall(beforeFirstReply, firstTrigger)

        const firstAnswered = yield* replyPermission(sdk, test.home, String(firstPending.id), "once")
        expect(firstAnswered.response.status).toBe(200)
        expect(firstAnswered.data).toBe(true)

        const firstMessages = yield* waitForMessages(
          sdk,
          test.home,
          sessionID,
          (value) => JSON.stringify(value).includes(firstContinuation) && callsMatch(value, first, "completed"),
          "timed out waiting for the once-approved cycle to complete",
        )
        yield* waitForIdle(sdk, test.home, sessionID)
        expectCalls(firstMessages, first, "completed")
        expect(yield* listPermissions(sdk, test.home)).toEqual([])
        expectPromptInputs(yield* test.llm.inputs, firstPrompt, 2)
        expect(yield* test.llm.pending).toBe(0)

        const second = alternatingFixture("once-second-call")
        const secondPrompt = "serve period-two after once reply"
        const secondContinuation = `${secondPrompt} continuation must remain queued`
        yield* enqueue(test.llm, secondPrompt, second.item, reply().text(secondContinuation).stop())

        const secondPrompted = yield* prompt(sdk, sessionID, secondPrompt)
        expect(secondPrompted.response.status).toBe(204)
        const secondPending = yield* waitForDoomLoopPermission(sdk, test.home, sessionID)
        const secondTrigger = second.calls.at(-1)
        if (!secondTrigger) throw new Error("follow-up fixture did not contain a trigger call")
        expectPermission({ pending: secondPending, sessionID, trigger: secondTrigger })
        expect(secondPending.id).not.toBe(firstPending.id)
        const beforeSecondReply = yield* waitForMessages(
          sdk,
          test.home,
          sessionID,
          (value) => toolParts(value).some((part) => part.callID === secondTrigger.id),
          "timed out waiting for the follow-up threshold call",
        )
        expectPendingCall(beforeSecondReply, secondTrigger)

        const secondAnswered = yield* replyPermission(sdk, test.home, String(secondPending.id), "reject")
        expect(secondAnswered.response.status).toBe(200)
        expect(secondAnswered.data).toBe(true)
        const secondMessages = yield* waitForMessages(
          sdk,
          test.home,
          sessionID,
          (value) => hasAssistantError(value) && rejectedCallsMatch(value, second),
          "timed out waiting for the follow-up rejection to settle",
        )
        yield* waitForIdle(sdk, test.home, sessionID)
        expect(JSON.stringify(secondMessages)).not.toContain(secondContinuation)
        expectRejectedCalls(secondMessages, second)
        expect(yield* listPermissions(sdk, test.home)).toEqual([])
        expectPromptInputs(yield* test.llm.inputs, secondPrompt, 1)
        expect(yield* test.llm.pending).toBe(1)
      }),
    TEST_TIMEOUT_MS,
  )

  cliIt.live(
    "stops a periodic cycle after the SDK replies reject",
    (test) =>
      Effect.gen(function* () {
        const fixture = alternatingFixture("reject-call")
        const promptText = "serve period-two reject reply"
        const continuation = `${promptText} continuation must remain queued`
        yield* enqueue(test.llm, promptText, fixture.item, reply().text(continuation).stop())

        const server = yield* test.opencode.serve({ readyTimeoutMs: SERVER_READY_TIMEOUT_MS })
        const sdk = createOpencodeClient({ baseUrl: server.url, directory: test.home })
        const created = yield* call(() => sdk.session.create({ title: "periodic reject" }), "session creation")
        expect(created.response.status).toBe(200)
        const sessionID = String(record(created.data).id)

        const prompted = yield* prompt(sdk, sessionID, promptText)
        expect(prompted.response.status).toBe(204)

        const pending = yield* waitForDoomLoopPermission(sdk, test.home, sessionID)
        const trigger = fixture.calls.at(-1)
        if (!trigger) throw new Error("periodic fixture did not contain a trigger call")
        expectPermission({ pending, sessionID, trigger })
        expect(record((yield* sessionStatus(sdk, test.home))[sessionID]).type).toBe("busy")
        const beforeReply = yield* waitForMessages(
          sdk,
          test.home,
          sessionID,
          (value) => toolParts(value).some((part) => part.callID === trigger.id),
          "timed out waiting for the threshold call before rejection",
        )
        expectPendingCall(beforeReply, trigger)

        const answered = yield* replyPermission(sdk, test.home, String(pending.id), "reject")
        expect(answered.response.status).toBe(200)
        expect(answered.data).toBe(true)

        const terminalMessages = yield* waitForMessages(
          sdk,
          test.home,
          sessionID,
          (value) => hasAssistantError(value) && rejectedCallsMatch(value, fixture),
          "timed out waiting for the rejected cycle to settle",
        )
        yield* waitForIdle(sdk, test.home, sessionID)
        expect(JSON.stringify(terminalMessages)).not.toContain(continuation)
        expectRejectedCalls(terminalMessages, fixture)
        expect(yield* listPermissions(sdk, test.home)).toEqual([])
        expectPromptInputs(yield* test.llm.inputs, promptText, 1)
        expect(yield* test.llm.pending).toBe(1)
      }),
    TEST_TIMEOUT_MS,
  )
})
