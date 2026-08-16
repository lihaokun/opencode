import { SessionV1 } from "@opencode-ai/core/v1/session"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { APICallError, tool } from "ai"
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect"
import path from "path"
import z from "zod"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LLMEvent } from "@opencode-ai/llm"
import { Plugin } from "@/plugin"
import { Question } from "@/question"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function contextOverflowError() {
  return new APICallError({
    message: "request entity too large",
    url: "https://example.com/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 413,
    responseHeaders: { "content-type": "application/json" },
    responseBody: JSON.stringify({ error: { message: "request entity too large" } }),
    isRetryable: false,
  })
}

const waitFor = <A>(check: Effect.Effect<A | undefined>, message: string) =>
  Effect.gen(function* () {
    const stop = Date.now() + 500
    while (Date.now() < stop) {
      const value = yield* check
      if (value !== undefined) return value
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(message))
  })

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const root = LayerNode.group([
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  CrossSpawnSpawner.node,
])
const replacements = [
  [SessionSummary.node, summary],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
] as const
const env = LayerNode.compile(
  LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
  replacements,
)

const it = testEffect(env)

function batchLLM(
  streamBatches: LLM.Interface["streamBatches"],
  stream: LLM.Interface["stream"] = (input) =>
    streamBatches(input).pipe(Stream.flatMap((batch) => Stream.fromIterable(batch))),
) {
  return LLM.Service.of({
    preparePayload: (input) => Effect.succeed({ system: input.system, messages: input.messages, tools: input.tools }),
    stream,
    streamBatches,
  })
}

function singletonBatchLLM(stream: LLM.Interface["stream"]) {
  return LLM.Service.of({
    preparePayload: (input) => Effect.succeed({ system: input.system, messages: input.messages, tools: input.tools }),
    stream,
    streamBatches: (input) => stream(input).pipe(Stream.map((event) => [event])),
  })
}

const providerErrorLLM = Layer.succeed(
  LLM.Service,
  singletonBatchLLM(() =>
    Stream.make(
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
      LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
      LLMEvent.toolCall({ id: "call-1", name: "lookup", input: {}, providerExecuted: true }),
      LLMEvent.toolResult({
        id: "call-1",
        name: "lookup",
        result: { type: "error", value: "provider boom" },
        providerExecuted: true,
      }),
      LLMEvent.stepFinish({ index: 0, reason: "stop" }),
      LLMEvent.finish({ reason: "stop" }),
    ),
  ),
)
const providerErrorEnv = LayerNode.compile(root, [...replacements, [LLM.node, providerErrorLLM]])
const itProviderError = testEffect(providerErrorEnv)

const fragmentFailureLLM = Layer.succeed(
  LLM.Service,
  singletonBatchLLM(() =>
    Stream.make(
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.reasoningStart({ id: "reasoning-1" }),
      LLMEvent.reasoningDelta({ id: "reasoning-1", text: "thinking" }),
      LLMEvent.textStart({ id: "text-1" }),
      LLMEvent.textDelta({ id: "text-1", text: "partial" }),
      LLMEvent.providerError({ message: "provider boom" }),
    ),
  ),
)
const fragmentFailureEnv = LayerNode.compile(root, [...replacements, [LLM.node, fragmentFailureLLM]])
const itFragmentFailure = testEffect(fragmentFailureEnv)

const lengthLLM = Layer.succeed(
  LLM.Service,
  singletonBatchLLM(() =>
    Stream.make(
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.stepFinish({ index: 0, reason: "length" }),
      LLMEvent.finish({ reason: "length" }),
    ),
  ),
)
const lengthEnv = LayerNode.compile(root, [...replacements, [LLM.node, lengthLLM]])
const itLength = testEffect(lengthEnv)

const failingSnapshot = Layer.effect(
  Snapshot.Service,
  Effect.sync(() => {
    return Snapshot.Service.of({
      init: () => Effect.void,
      cleanup: () => Effect.void,
      track: () => Effect.succeed("snapshot"),
      patch: () => Effect.die(new Error("secondary snapshot failure")),
      restore: () => Effect.void,
      revert: () => Effect.void,
      diff: () => Effect.succeed(""),
      diffFull: () => Effect.succeed([]),
    })
  }),
)
const lengthThenFailureEnv = LayerNode.compile(root, [
  ...replacements,
  [LLM.node, lengthLLM],
  [Snapshot.node, failingSnapshot],
])
const itLengthThenFailure = testEffect(lengthThenFailureEnv)

function settlementStream(name: string): Stream.Stream<LLMEvent, unknown> {
  switch (name) {
    case "empty-unknown":
      return Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
        LLMEvent.finish({ reason: "unknown" }),
      )
    case "empty":
      return Stream.empty
    case "final-only":
      return Stream.make(LLMEvent.finish({ reason: "stop" }))
    case "multi-step-incomplete":
      return Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.stepStart({ index: 1 }),
        LLMEvent.finish({ reason: "stop" }),
      )
    case "unknown-then-incomplete":
      return Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
        LLMEvent.stepStart({ index: 1 }),
      )
    case "unknown-visible":
    case "plugin-clear":
      return Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: `${name}-text` }),
        LLMEvent.textDelta({ id: `${name}-text`, text: "visible" }),
        LLMEvent.textEnd({ id: `${name}-text` }),
        LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
        LLMEvent.finish({ reason: "unknown" }),
      )
    case "unknown-partial":
      return Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "partial-text" }),
        LLMEvent.textDelta({ id: "partial-text", text: "partial" }),
        LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
        LLMEvent.finish({ reason: "unknown" }),
      )
    case "unknown-whitespace":
      return Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "whitespace-text" }),
        LLMEvent.textDelta({ id: "whitespace-text", text: " \n\t " }),
        LLMEvent.textEnd({ id: "whitespace-text" }),
        LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
        LLMEvent.finish({ reason: "unknown" }),
      )
    case "unknown-reasoning":
      return Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-only" }),
        LLMEvent.reasoningDelta({ id: "reasoning-only", text: "private reasoning" }),
        LLMEvent.reasoningEnd({ id: "reasoning-only" }),
        LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
        LLMEvent.finish({ reason: "unknown" }),
      )
    case "unknown-pending-tool":
      return Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "pending-call", name: "lookup" }),
        LLMEvent.toolInputDelta({ id: "pending-call", name: "lookup", text: "{}" }),
        LLMEvent.toolInputEnd({ id: "pending-call", name: "lookup" }),
        LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
        LLMEvent.finish({ reason: "unknown" }),
      )
    case "plugin-fill":
      return Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "plugin-fill-text" }),
        LLMEvent.textDelta({ id: "plugin-fill-text", text: "  " }),
        LLMEvent.textEnd({ id: "plugin-fill-text" }),
        LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
        LLMEvent.finish({ reason: "unknown" }),
      )
    case "unknown-tool":
      return Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-1", name: "lookup", input: {} }),
        LLMEvent.toolResult({
          id: "call-1",
          name: "lookup",
          result: { type: "json", value: { title: "lookup", output: "done", metadata: {} } },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
        LLMEvent.finish({ reason: "unknown" }),
      )
    case "provider-error":
      return Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.providerError({ message: "specific provider failure", retryable: false }),
      )
    case "context-overflow":
      return Stream.fail(contextOverflowError())
    case "context-overflow-after-text-start":
      return Stream.make(LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "late-text" })).pipe(
        Stream.concat(Stream.fail(contextOverflowError())),
      )
    case "context-overflow-after-reasoning-start":
      return Stream.make(LLMEvent.stepStart({ index: 0 }), LLMEvent.reasoningStart({ id: "late-reasoning" })).pipe(
        Stream.concat(Stream.fail(contextOverflowError())),
      )
    case "context-overflow-after-tool-input-start":
      return Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "late-tool", name: "lookup" }),
      ).pipe(Stream.concat(Stream.fail(contextOverflowError())))
    case "context-overflow-after-tool-call":
      return Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "late-tool-call", name: "lookup", input: {} }),
      ).pipe(Stream.concat(Stream.fail(contextOverflowError())))
    case "blocked-permission":
      return Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-blocked", name: "lookup", input: {} }),
        LLMEvent.toolError({
          id: "call-blocked",
          name: "lookup",
          message: "permission rejected",
          error: new PermissionV1.RejectedError(),
        }),
      )
    case "blocked-question":
      return Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-blocked", name: "lookup", input: {} }),
        LLMEvent.toolError({
          id: "call-blocked",
          name: "lookup",
          message: "question dismissed",
          error: new Question.RejectedError(),
        }),
      )
    default:
      throw new Error(`Unknown settlement scenario: ${name}`)
  }
}

const settlementLLM = Layer.succeed(
  LLM.Service,
  singletonBatchLLM((input) => {
    const content = input.messages.at(-1)?.content
    return settlementStream(typeof content === "string" ? content : "")
  }),
)
const settlementEnv = LayerNode.compile(root, [...replacements, [LLM.node, settlementLLM]])
const itSettlement = testEffect(settlementEnv)

const highUsage = { inputTokens: 100, outputTokens: 1, totalTokens: 101 }
const successorDemand = new Map<string, number>()

function withSuccessorProbe(
  name: string,
  batches: ReadonlyArray<LLM.LLMEventBatch>,
): Stream.Stream<LLM.LLMEventBatch, unknown> {
  return Stream.fromIterable(batches).pipe(
    Stream.concat(
      Stream.fromEffect(
        Effect.sync(() => {
          successorDemand.set(name, (successorDemand.get(name) ?? 0) + 1)
          return [LLMEvent.providerError({ message: "unexpected next batch" })]
        }),
      ),
    ),
  )
}

function boundaryBatches(name: string): Stream.Stream<LLM.LLMEventBatch, unknown> {
  switch (name) {
    case "canonical-overflow-reasoning":
      return withSuccessorProbe(name, [
        [LLMEvent.stepStart({ index: 0 })],
        [LLMEvent.reasoningStart({ id: "crossover-reasoning" })],
        [LLMEvent.reasoningDelta({ id: "crossover-reasoning", text: "private partial" })],
        [LLMEvent.reasoningEnd({ id: "crossover-reasoning" })],
        [
          LLMEvent.stepFinish({ index: 0, reason: "unknown", usage: highUsage }),
          LLMEvent.providerError({
            message: "Provider stream ended without a terminal finish event",
            retryable: false,
          }),
        ],
      ])
    case "raw-defined-overflow":
      return withSuccessorProbe(name, [
        [LLMEvent.stepStart({ index: 0 })],
        [LLMEvent.textStart({ id: "compatible-text" })],
        [LLMEvent.textDelta({ id: "compatible-text", text: "compatible partial" })],
        [LLMEvent.stepFinish({ index: 0, reason: "unknown", usage: highUsage })],
      ])
    case "empty-unknown-overflow":
      return withSuccessorProbe(name, [
        [LLMEvent.stepStart({ index: 0 })],
        [LLMEvent.stepFinish({ index: 0, reason: "unknown", usage: highUsage })],
      ])
    case "length-overflow":
      return withSuccessorProbe(name, [
        [LLMEvent.stepStart({ index: 0 })],
        [LLMEvent.stepFinish({ index: 0, reason: "length", usage: highUsage })],
      ])
    case "blocked-overflow":
      return withSuccessorProbe(name, [
        [LLMEvent.stepStart({ index: 0 })],
        [LLMEvent.toolCall({ id: "blocked-call", name: "lookup", input: {} })],
        [
          LLMEvent.toolError({
            id: "blocked-call",
            name: "lookup",
            message: "permission rejected",
            error: new PermissionV1.RejectedError(),
          }),
        ],
        [LLMEvent.stepFinish({ index: 0, reason: "stop", usage: highUsage })],
      ])
    default:
      return Stream.die(new Error(`Unknown batch boundary scenario: ${name}`))
  }
}

const boundaryLLM = Layer.succeed(
  LLM.Service,
  batchLLM(
    (input) => {
      const content = input.messages.at(-1)?.content
      return boundaryBatches(typeof content === "string" ? content : "")
    },
    () => Stream.die(new Error("processor must consume streamBatches")),
  ),
)
const boundaryEnv = LayerNode.compile(root, [...replacements, [LLM.node, boundaryLLM]])
const itBoundary = testEffect(boundaryEnv)

const textEvidencePlugin = Layer.mock(Plugin.Service)({
  trigger: <Output>(name: string, _input: unknown, output: Output) => {
    if (
      name === "experimental.text.complete" &&
      typeof output === "object" &&
      output !== null &&
      "text" in output &&
      typeof output.text === "string"
    ) {
      output.text = output.text.trim().length > 0 ? "" : "plugin visible"
    }
    return Effect.succeed(output)
  },
  list: () => Effect.succeed([]),
  init: () => Effect.void,
})
const textEvidenceEnv = LayerNode.compile(root, [
  ...replacements,
  [LLM.node, settlementLLM],
  [Plugin.node, textEvidencePlugin],
])
const itTextEvidence = testEffect(textEvidenceEnv)

const attemptEvidenceLLM = Layer.effect(
  LLM.Service,
  Effect.sync(() => {
    let attempt = 0
    return singletonBatchLLM(() => {
      attempt++
      if (attempt > 1) {
        return Stream.make(
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
          LLMEvent.finish({ reason: "unknown" }),
        )
      }
      return Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "attempt-1-text" }),
        LLMEvent.textDelta({ id: "attempt-1-text", text: "first attempt" }),
        LLMEvent.textEnd({ id: "attempt-1-text" }),
        LLMEvent.stepFinish({ index: 0, reason: "unknown" }),
      ).pipe(
        Stream.concat(
          Stream.fail(
            new APICallError({
              message: "retry",
              url: "https://example.com/v1/chat/completions",
              requestBodyValues: {},
              statusCode: 503,
              responseHeaders: { "retry-after-ms": "0" },
              responseBody: '{"error":"retry"}',
              isRetryable: true,
            }),
          ),
        ),
      )
    })
  }),
)
const attemptEvidenceEnv = LayerNode.compile(root, [...replacements, [LLM.node, attemptEvidenceLLM]])
const itAttemptEvidence = testEffect(attemptEvidenceEnv)

const compactionAttemptLLM = Layer.effect(
  LLM.Service,
  Effect.sync(() => {
    let attempt = 0
    const batches = (): Stream.Stream<LLM.LLMEventBatch, unknown> => {
      attempt++
      if (attempt > 1) {
        return Stream.fromIterable([
          [LLMEvent.stepStart({ index: 0 })],
          [LLMEvent.textStart({ id: "attempt-2-text" })],
          [LLMEvent.textDelta({ id: "attempt-2-text", text: "second attempt" })],
          [LLMEvent.textEnd({ id: "attempt-2-text" })],
          [LLMEvent.stepFinish({ index: 0, reason: "stop" })],
          [LLMEvent.finish({ reason: "stop" })],
        ])
      }
      return Stream.fromIterable([
        [LLMEvent.stepStart({ index: 0 })],
        [LLMEvent.textStart({ id: "attempt-1-overflow-text" })],
        [LLMEvent.textDelta({ id: "attempt-1-overflow-text", text: "first attempt" })],
        [LLMEvent.textEnd({ id: "attempt-1-overflow-text" })],
        [
          LLMEvent.stepFinish({ index: 0, reason: "stop", usage: highUsage }),
          LLMEvent.providerError({ message: "rate limit", retryable: true }),
        ],
      ])
    }
    return batchLLM(
      () => Stream.suspend(batches),
      () => Stream.die(new Error("processor must consume streamBatches")),
    )
  }),
)
const compactionAttemptEnv = LayerNode.compile(root, [...replacements, [LLM.node, compactionAttemptLLM]])
const itCompactionAttempt = testEffect(compactionAttemptEnv)

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

const runSettlement = Effect.fn("test.runSettlement")(function* (
  dir: string,
  scenario: string,
  options?: {
    limit?: { context: number; output: number }
    recoverContextOverflow?: boolean
    unfinished?: boolean
  },
) {
  const { processors, session, provider } = yield* boot()
  const eventBridge = yield* EventV2Bridge.Service
  const chat = yield* session.create({})
  const parent = yield* user(chat.id, scenario)
  const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
  if (options?.unfinished) {
    delete msg.finish
    yield* session.updateMessage(msg)
  }
  const base = yield* provider.getModel(ref.providerID, ref.modelID)
  const mdl = options?.limit ? { ...base, limit: options.limit } : base
  const errors: NonNullable<SessionV1.Assistant["error"]>[] = []
  const off = yield* eventBridge.listen((event) => {
    if (event.type !== Session.Event.Error.type) return Effect.void
    const data = event.data as typeof Session.Event.Error.data.Type
    if (data.sessionID === chat.id && data.error) errors.push(data.error)
    return Effect.void
  })
  const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
  const result = yield* handle.process(
    {
      user: {
        id: parent.id,
        sessionID: chat.id,
        role: "user",
        time: parent.time,
        agent: parent.agent,
        model: { providerID: ref.providerID, modelID: ref.modelID },
      } satisfies SessionV1.User,
      sessionID: chat.id,
      model: mdl,
      agent: agent(),
      system: [],
      messages: [{ role: "user", content: scenario }],
      tools: {},
    },
    { recoverContextOverflow: options?.recoverContextOverflow },
  )
  yield* off
  return {
    result,
    message: handle.message,
    stored: yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id }),
    parts: yield* MessageV2.parts(msg.id),
    errors,
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

itLength.live("session.processor normalizes length into one durable terminal error", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "truncate")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const errors: NonNullable<SessionV1.Assistant["error"]>[] = []
        const off = yield* events.listen((event) => {
          if (event.type !== Session.Event.Error.type) return Effect.void
          const data = event.data as typeof Session.Event.Error.data.Type
          if (data.sessionID === chat.id && data.error) errors.push(data.error)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "truncate" }],
          tools: {},
        })
        yield* off

        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("stop")
        expect(handle.message.finish).toBe("length")
        expect(handle.message.error?.name).toBe("MessageOutputLengthError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.finish).toBe("length")
          expect(stored.info.error?.name).toBe("MessageOutputLengthError")
        }
        expect(parts).toContainEqual(expect.objectContaining({ type: "step-finish", reason: "length" }))
        expect(errors.map((error) => error.name)).toEqual(["MessageOutputLengthError"])
      }),
    { config: cfg },
  ),
)

itLength.live("session.processor preserves an earlier terminal error on length", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "preserve")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        msg.error = new SessionV1.ContentFilterError({ message: "blocked first" }).toObject()
        yield* session.updateMessage(msg)
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const errors: NonNullable<SessionV1.Assistant["error"]>[] = []
        const off = yield* events.listen((event) => {
          if (event.type !== Session.Event.Error.type) return Effect.void
          const data = event.data as typeof Session.Event.Error.data.Type
          if (data.sessionID === chat.id && data.error) errors.push(data.error)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "preserve" }],
          tools: {},
        })
        yield* off

        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        expect(value).toBe("stop")
        expect(handle.message.finish).toBe("length")
        expect(handle.message.error).toEqual(msg.error)
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") expect(stored.info.error).toEqual(msg.error)
        expect(errors).toEqual([])
      }),
    { config: cfg },
  ),
)

itLengthThenFailure.live("session.processor preserves length across a later snapshot failure", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "secondary")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const errors: NonNullable<SessionV1.Assistant["error"]>[] = []
        const off = yield* events.listen((event) => {
          if (event.type !== Session.Event.Error.type) return Effect.void
          const data = event.data as typeof Session.Event.Error.data.Type
          if (data.sessionID === chat.id && data.error) errors.push(data.error)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "secondary" }],
          tools: {},
        })
        yield* off

        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        expect(value).toBe("stop")
        expect(handle.message.finish).toBe("length")
        expect(handle.message.error?.name).toBe("MessageOutputLengthError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.finish).toBe("length")
          expect(stored.info.error?.name).toBe("MessageOutputLengthError")
        }
        expect(errors.map((error) => error.name)).toEqual(["MessageOutputLengthError"])
      }),
    { config: cfg },
  ),
)

itSettlement.live("session.processor rejects an empty unknown finish with one durable error", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const result = yield* runSettlement(dir, "empty-unknown")
        const expected = {
          name: "UnknownError",
          data: { message: "Provider stream ended with an unknown finish reason and no usable output" },
        }

        expect(result.result).toBe("stop")
        expect(result.message.finish).toBe("unknown")
        expect(result.message.error).toMatchObject(expected)
        expect(result.stored.info.role).toBe("assistant")
        if (result.stored.info.role === "assistant") {
          expect(result.stored.info.finish).toBe("unknown")
          expect(result.stored.info.error).toMatchObject(expected)
        }
        expect(result.errors).toHaveLength(1)
        expect(result.errors[0]).toMatchObject(expected)
      }),
    { config: cfg },
  ),
)

itSettlement.live("session.processor excludes reasoning, whitespace, and pending tool input from usable output", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        for (const scenario of ["unknown-reasoning", "unknown-whitespace", "unknown-pending-tool"]) {
          const result = yield* runSettlement(dir, scenario)
          expect(result.result).toBe("stop")
          expect(result.message.finish).toBe("unknown")
          expect(result.message.error).toMatchObject({
            name: "UnknownError",
            data: { message: "Provider stream ended with an unknown finish reason and no usable output" },
          })
          expect(result.errors).toHaveLength(1)
        }
      }),
    { config: cfg },
  ),
)

itSettlement.live("session.processor rejects every stream without a credible final step settlement", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        for (const scenario of ["empty", "final-only", "multi-step-incomplete"]) {
          const result = yield* runSettlement(dir, scenario)
          const expected = {
            name: "UnknownError",
            data: { message: "Provider stream ended without a settled model step" },
          }

          expect(result.result).toBe("stop")
          expect(result.message.finish).toBe("error")
          expect(result.message.error).toMatchObject(expected)
          expect(result.errors).toHaveLength(1)
          expect(result.errors[0]).toMatchObject(expected)
        }
      }),
    { config: cfg },
  ),
)

itSettlement.live("session.processor gives no-step settlement priority over an earlier empty unknown", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const result = yield* runSettlement(dir, "unknown-then-incomplete")

        expect(result.result).toBe("stop")
        expect(result.message.finish).toBe("error")
        expect(result.message.error).toMatchObject({
          name: "UnknownError",
          data: { message: "Provider stream ended without a settled model step" },
        })
        expect(result.errors).toHaveLength(1)
      }),
    { config: cfg },
  ),
)

itSettlement.live("session.processor accepts unknown finishes with usable text or complete tool evidence", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        for (const scenario of ["unknown-visible", "unknown-partial", "unknown-tool"]) {
          const result = yield* runSettlement(dir, scenario)
          expect(result.result).toBe("continue")
          expect(result.message.finish).toBe("unknown")
          expect(result.message.error).toBeUndefined()
          expect(result.errors).toEqual([])
        }
      }),
    { config: cfg },
  ),
)

itBoundary.live("session.processor handles a complete terminal-error batch before compaction cutoff", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const result = yield* runSettlement(dir, "canonical-overflow-reasoning", {
          limit: { context: 20, output: 10 },
        })

        expect(result.result).toBe("stop")
        expect(result.message.finish).toBe("unknown")
        expect(result.message.tokens.input).toBe(100)
        expect(result.message.error).toMatchObject({
          name: "UnknownError",
          data: { message: "Provider stream ended without a terminal finish event" },
        })
        expect(result.parts).toContainEqual(expect.objectContaining({ type: "reasoning", text: "private partial" }))
        expect(result.errors).toHaveLength(1)
        expect(result.errors[0]).toMatchObject({
          name: "UnknownError",
          data: { message: "Provider stream ended without a terminal finish event" },
        })
      }),
    { config: cfg },
  ),
)

itBoundary.live("session.processor keeps raw-defined unknown overflow compatible without demanding a successor", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        successorDemand.set("raw-defined-overflow", 0)
        const result = yield* runSettlement(dir, "raw-defined-overflow", {
          limit: { context: 20, output: 10 },
        })

        expect(result.result).toBe("compact")
        expect(result.message.finish).toBe("unknown")
        expect(result.message.error).toBeUndefined()
        expect(result.parts).toContainEqual(expect.objectContaining({ type: "text", text: "compatible partial" }))
        expect(result.errors).toEqual([])
        expect(successorDemand.get("raw-defined-overflow")).toBe(0)
      }),
    { config: cfg },
  ),
)

itBoundary.live("session.processor gives an empty unknown error priority over compaction", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        successorDemand.set("empty-unknown-overflow", 0)
        const result = yield* runSettlement(dir, "empty-unknown-overflow", {
          limit: { context: 20, output: 10 },
        })

        expect(result.result).toBe("stop")
        expect(result.message.error).toMatchObject({
          name: "UnknownError",
          data: { message: "Provider stream ended with an unknown finish reason and no usable output" },
        })
        expect(result.errors).toHaveLength(1)
        expect(result.errors[0]).toMatchObject({
          name: "UnknownError",
          data: { message: "Provider stream ended with an unknown finish reason and no usable output" },
        })
        expect(successorDemand.get("empty-unknown-overflow")).toBe(0)
      }),
    { config: cfg },
  ),
)

itBoundary.live("session.processor gives length and blocked terminals priority over compaction", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const length = yield* runSettlement(dir, "length-overflow", {
          limit: { context: 20, output: 10 },
        })
        expect(length.result).toBe("stop")
        expect(length.message.error?.name).toBe("MessageOutputLengthError")
        expect(length.errors).toHaveLength(1)
        expect(length.errors[0]?.name).toBe("MessageOutputLengthError")

        const blocked = yield* runSettlement(dir, "blocked-overflow", {
          limit: { context: 20, output: 10 },
        })
        expect(blocked.result).toBe("stop")
        expect(blocked.message.error).toBeUndefined()
        expect(blocked.errors).toEqual([])
      }),
    { config: cfg },
  ),
)

itSettlement.live("session.processor preserves a specific provider error instead of adding a generic fallback", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const result = yield* runSettlement(dir, "provider-error")

        expect(result.result).toBe("stop")
        expect(result.message.error).toMatchObject({
          name: "UnknownError",
          data: { message: "specific provider failure" },
        })
        expect(result.errors).toHaveLength(1)
        expect(result.errors[0]).toMatchObject({
          name: "UnknownError",
          data: { message: "specific provider failure" },
        })
      }),
    { config: cfg },
  ),
)

itSettlement.live("session.processor recovers a context overflow when the attempt is eligible", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const result = yield* runSettlement(dir, "context-overflow", {
          recoverContextOverflow: true,
          unfinished: true,
        })

        expect(result.result).toBe("compact")
        expect(result.message.finish).toBeUndefined()
        expect(result.message.error).toBeUndefined()
        expect(result.stored.info.role).toBe("assistant")
        if (result.stored.info.role === "assistant") {
          expect(result.stored.info.finish).toBeUndefined()
          expect(result.stored.info.error).toBeUndefined()
          expect(result.stored.info.time.completed).toBeNumber()
        }
      }),
    { config: cfg },
  ),
)

itSettlement.live("session.processor persists context overflow when attempt recovery is disabled", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const result = yield* runSettlement(dir, "context-overflow", {
          recoverContextOverflow: false,
          unfinished: true,
        })

        expect(result.result).toBe("stop")
        expect(result.message.finish).toBe("error")
        expect(result.message.error).toMatchObject({
          name: "ContextOverflowError",
          data: {
            message: expect.stringContaining("request entity too large"),
            responseBody: JSON.stringify({ error: { message: "request entity too large" } }),
          },
        })
        if (!result.message.error) throw new Error("expected context overflow error")
        expect(result.message.time.completed).toBeNumber()
        expect(result.stored.info.role).toBe("assistant")
        if (result.stored.info.role === "assistant") {
          expect(result.stored.info.finish).toBe(result.message.finish)
          expect(result.stored.info.error).toEqual(result.message.error)
          expect(result.stored.info.time.completed).toBe(result.message.time.completed)
        }
        expect(result.errors).toEqual([result.message.error])
      }),
    { config: cfg },
  ),
)

for (const scenario of [
  "context-overflow-after-text-start",
  "context-overflow-after-reasoning-start",
  "context-overflow-after-tool-input-start",
  "context-overflow-after-tool-call",
]) {
  itSettlement.live(`session.processor does not recover ${scenario}`, () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const result = yield* runSettlement(dir, scenario, {
            recoverContextOverflow: true,
            unfinished: true,
          })

          expect(result.result).toBe("stop")
          expect(result.message.finish).toBe("error")
          expect(result.message.error?.name).toBe("ContextOverflowError")
          expect(result.message.time.completed).toBeNumber()
          expect(result.stored.info.role).toBe("assistant")
          if (result.stored.info.role === "assistant") {
            expect(result.stored.info.finish).toBe("error")
            expect(result.stored.info.error).toEqual(result.message.error)
            expect(result.stored.info.time.completed).toBe(result.message.time.completed)
          }
        }),
      { config: cfg },
    ),
  )
}

itSettlement.live("session.processor does not replace a blocked tool turn with an incomplete-stream error", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        for (const [scenario, message] of [
          ["blocked-permission", new PermissionV1.RejectedError().message],
          ["blocked-question", new Question.RejectedError().message],
        ] as const) {
          const result = yield* runSettlement(dir, scenario)

          expect(result.result).toBe("stop")
          expect(result.message.error).toBeUndefined()
          expect(result.errors).toEqual([])
          expect(result.parts).toContainEqual(
            expect.objectContaining({
              type: "tool",
              state: expect.objectContaining({
                status: "error",
                error: message,
              }),
            }),
          )
        }
      }),
    { config: cfg },
  ),
)

itTextEvidence.live("session.processor bases usable text evidence on the plugin-completed value", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const filled = yield* runSettlement(dir, "plugin-fill")
        expect(filled.result).toBe("continue")
        expect(filled.message.error).toBeUndefined()
        expect(filled.parts).toContainEqual(expect.objectContaining({ type: "text", text: "plugin visible" }))

        const cleared = yield* runSettlement(dir, "plugin-clear")
        expect(cleared.result).toBe("stop")
        expect(cleared.message.error).toMatchObject({
          name: "UnknownError",
          data: { message: "Provider stream ended with an unknown finish reason and no usable output" },
        })
        expect(cleared.parts).toContainEqual(expect.objectContaining({ type: "text", text: "" }))
      }),
    { config: cfg },
  ),
)

itAttemptEvidence.live("session.processor resets finish and output evidence before a retry attempt", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const result = yield* runSettlement(dir, "retry-attempt")

        expect(result.result).toBe("stop")
        expect(result.message.finish).toBe("unknown")
        expect(result.message.error).toMatchObject({
          name: "UnknownError",
          data: { message: "Provider stream ended with an unknown finish reason and no usable output" },
        })
        expect(result.parts).toContainEqual(expect.objectContaining({ type: "text", text: "first attempt" }))
        expect(result.parts.filter((part) => part.type === "step-finish")).toHaveLength(2)
        expect(result.errors).toHaveLength(1)
      }),
    { config: cfg },
  ),
)

itCompactionAttempt.live("session.processor resets compaction state before a retry attempt", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const result = yield* runSettlement(dir, "retry-compaction-state", {
          limit: { context: 20, output: 10 },
        })

        expect(result.result).toBe("continue")
        expect(result.message.finish).toBe("stop")
        expect(result.message.error).toBeUndefined()
        expect(result.parts).toContainEqual(expect.objectContaining({ type: "text", text: "first attempt" }))
        expect(result.parts).toContainEqual(expect.objectContaining({ type: "text", text: "second attempt" }))
        expect(result.parts.filter((part) => part.type === "step-finish")).toHaveLength(2)
        expect(result.errors).toEqual([])
      }),
    { config: cfg },
  ),
)

it.live("session.processor effect tests capture llm input cleanly", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.text("hello")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const input = {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        } satisfies LLM.StreamInput

        const value = yield* handle.process(input)
        const parts = yield* MessageV2.parts(msg.id)
        const calls = yield* llm.calls

        expect(value).toBe("continue")
        expect(calls).toBe(1)
        expect(parts.some((part) => part.type === "text" && part.text === "hello")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests preserve text start time", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const gate = defer<void>()
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { content: "hello" } }],
              },
            ],
            wait: gate.promise,
            tail: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "stop" }],
              },
            ],
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hi" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.TextPart => part.type === "text")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for text part",
        )
        yield* Effect.sleep("20 millis")
        gate.resolve()

        const exit = yield* Fiber.await(run)
        const text = (yield* MessageV2.parts(msg.id)).find((part): part is SessionV1.TextPart => part.type === "text")

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(text?.text).toBe("hello")
        expect(text?.time?.start).toBeDefined()
        expect(text?.time?.end).toBeDefined()
        if (!text?.time?.start || !text.time.end) return
        expect(text.time.start).toBeLessThan(text.time.end)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests stop after token overflow requests compaction", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.text("after", { usage: { input: 100, output: 0 } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const base = yield* provider.getModel(ref.providerID, ref.modelID)
        const mdl = { ...base, limit: { context: 20, output: 10 } }
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("compact")
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(parts.some((part) => part.type === "step-finish")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor preserves a missing-finish error when usage requests compaction", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        yield* llm.push(
          raw({
            chunks: [
              {
                id: "chatcmpl-missing-finish-overflow",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-missing-finish-overflow",
                object: "chat.completion.chunk",
                choices: [{ delta: { content: "partial before cutoff" } }],
              },
              {
                id: "chatcmpl-missing-finish-overflow",
                object: "chat.completion.chunk",
                choices: [{ delta: {} }],
                usage: {
                  prompt_tokens: 100,
                  completion_tokens: 1,
                  total_tokens: 101,
                },
              },
            ],
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact incomplete")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const base = yield* provider.getModel(ref.providerID, ref.modelID)
        const mdl = { ...base, limit: { context: 20, output: 10 } }
        const errors: NonNullable<SessionV1.Assistant["error"]>[] = []
        const off = yield* events.listen((event) => {
          if (event.type !== Session.Event.Error.type) return Effect.void
          const data = event.data as typeof Session.Event.Error.data.Type
          if (data.sessionID === chat.id && data.error) errors.push(data.error)
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact incomplete" }],
          tools: {},
        })
        yield* off

        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("stop")
        expect(handle.message.finish).toBe("unknown")
        expect(handle.message.tokens.input).toBe(100)
        expect(handle.message.error).toMatchObject({
          name: "UnknownError",
          data: { message: "Provider stream ended without a terminal finish event" },
        })
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") expect(stored.info.error).toEqual(handle.message.error)
        expect(parts).toContainEqual(expect.objectContaining({ type: "text", text: "partial before cutoff" }))
        expect(errors).toHaveLength(1)
        expect(errors[0]).toMatchObject({
          name: "UnknownError",
          data: { message: "Provider stream ended without a terminal finish event" },
        })
        expect(yield* llm.calls).toBe(1)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests capture reasoning from http mock", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("think").text("done").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.find((part): part is SessionV1.ReasoningPart => part.type === "reasoning")
        const text = parts.find((part): part is SessionV1.TextPart => part.type === "text")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(reasoning?.text).toBe("think")
        expect(text?.text).toBe("done")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor coalesces interleaved openai-compatible reasoning from http mock", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("think-1").text("answer-1").reason("think-2").text("answer-2").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.filter((part): part is SessionV1.ReasoningPart => part.type === "reasoning")
        const text = parts.find((part): part is SessionV1.TextPart => part.type === "text")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(reasoning).toHaveLength(1)
        expect(reasoning[0]?.text).toBe("think-1think-2")
        expect(text?.text).toBe("answer-1answer-2")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor keeps reasoning with empty tool call arrays in one part", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            chunks: [
              {
                id: "chatcmpl-issue-8",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-issue-8",
                object: "chat.completion.chunk",
                choices: [{ delta: { reasoning_content: "r1", tool_calls: [] } }],
              },
              {
                id: "chatcmpl-issue-8",
                object: "chat.completion.chunk",
                choices: [{ delta: { reasoning_content: "r2", tool_calls: [] } }],
              },
              {
                id: "chatcmpl-issue-8",
                object: "chat.completion.chunk",
                choices: [{ delta: { content: "done" } }],
              },
              {
                id: "chatcmpl-issue-8",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "stop" }],
              },
            ],
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.filter((part): part is SessionV1.ReasoningPart => part.type === "reasoning")
        const text = parts.find((part): part is SessionV1.TextPart => part.type === "text")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(reasoning).toHaveLength(1)
        expect(reasoning[0]).toMatchObject({ text: "r1r2", time: { end: expect.any(Number) } })
        expect(text?.text).toBe("done")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor finalizes pending reasoning when a compatible stream ends incomplete", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("one").text("bridge").streamError())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.filter((part): part is SessionV1.ReasoningPart => part.type === "reasoning")

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(reasoning).toHaveLength(1)
        expect(reasoning[0]).toMatchObject({ text: "one", time: { end: expect.any(Number) } })
        expect(JSON.stringify(handle.message.error)).toContain("terminal finish event")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests reset reasoning state across retries", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("one").reset(), reply().reason("two").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.filter((part): part is SessionV1.ReasoningPart => part.type === "reasoning")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(reasoning.some((part) => part.text === "two")).toBe(true)
        expect(reasoning.some((part) => part.text === "onetwo")).toBe(false)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests do not retry unknown json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { error: { message: "no_kv_space" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "json" }],
          tools: {},
        })

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error?.name).toBe("APIError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry recognized structured json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry json" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests publish retry status updates", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        yield* llm.error(503, { error: "boom" })
        yield* llm.text("")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const states: number[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== SessionStatus.Event.Status.type) return Effect.void
          const data = evt.data as typeof SessionStatus.Event.Status.data.Type
          if (data.sessionID === chat.id && data.status.type === "retry") states.push(data.status.attempt)
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry" }],
          tools: {},
        })

        yield* off

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(states).toStrictEqual([1])
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests compact on structured context overflow", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { type: "error", error: { code: "context_length_exceeded" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact json" }],
          tools: {},
        })

        expect(value).toBe("compact")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests complete AI SDK tool calls when native flag is off", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.tool("lookup", { query: "weather" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "tool" }],
          tools: {
            lookup: tool({
              description: "Look up information",
              inputSchema: z.object({ query: z.string() }),
              execute: async (input) => ({
                title: "Weather lookup",
                output: `result:${input.query}`,
                metadata: { source: "test" },
              }),
            }),
          },
        })

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(call?.callID).toBe("call_1")
        expect(call?.tool).toBe("lookup")
        expect(call?.state.status).toBe("completed")
        if (call?.state.status !== "completed") return
        expect(call.state.input).toEqual({ query: "weather" })
        expect(call.state.output).toBe("result:weather")
        expect(call.state.title).toBe("Weather lookup")
        expect(call.state.metadata).toEqual({ source: "test" })
        expect(call.state.time.start).toBeDefined()
        expect(call.state.time.end).toBeDefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark pending tools as aborted on cleanup", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.toolHang("bash", { cmd: "pwd" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "tool abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.ToolPart => part.type === "tool")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for tool part",
        )
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.error).toBe("Tool execution aborted")
          expect(call.state.metadata?.interrupted).toBe(true)
          expect(call.state.time.end).toBeDefined()
        }
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests record aborted errors and idle state", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const seen = defer<void>()
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const errs: string[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== Session.Event.Error.type) return Effect.void
          const data = evt.data as typeof Session.Event.Error.data.Type
          if (data.sessionID !== chat.id || !data.error) return Effect.void
          errs.push(data.error.name)
          seen.resolve()
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        yield* Effect.promise(() => seen.promise)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)
        yield* off

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
        expect(errs).toContain("MessageAbortedError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark interruptions aborted without manual abort", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "interrupt")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "interrupt" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
      }),
    { config: (url) => providerCfg(url) },
  ),
)

itProviderError.live("session.processor effect tests fail provider-executed error results", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider tool error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: string[] = []
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "provider tool error" }],
          tools: {},
        })
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") expect(call.state.error).toBe("provider boom")
        expect(seen).toContain(MessageV2.Event.PartUpdated.type)
        expect(seen).toContain(MessageV2.Event.Updated.type)
        expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
      }),
    { config: cfg },
  ),
)

itFragmentFailure.live("session.processor effect tests retain partial legacy parts without v2 events", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider failure")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: string[] = []
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        expect(
          yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "provider failure" }],
            tools: {},
          }),
        ).toBe("stop")
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        expect(parts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "text", text: "partial" }),
            expect.objectContaining({ type: "reasoning", text: "thinking" }),
          ]),
        )
        expect(seen).toContain(MessageV2.Event.PartUpdated.type)
        expect(seen).toContain(Session.Event.Error.type)
        expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
      }),
    { config: cfg },
  ),
)
