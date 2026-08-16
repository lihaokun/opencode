import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Session as SessionNs } from "../../src/session/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const noopBootstrapLayer = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const appLayer = AppNodeBuilder.build(
  LayerNode.group([FSUtil.node, CrossSpawnSpawner.node, InstanceStore.node, Database.node, SessionNs.node]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

const model = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

function overflowConfig(url: string): Partial<ConfigV1.Info> {
  const config = testProviderConfig(url)
  return {
    ...config,
    model: "test/test-model",
    compaction: { reserved: 30_000, tail_turns: 0 },
    provider: {
      ...config.provider,
      test: {
        ...config.provider.test,
        models: {
          ...config.provider.test.models,
          "test-model": {
            ...config.provider.test.models["test-model"],
            limit: {
              ...config.provider.test.models["test-model"].limit,
              input: 100_000,
            },
          },
        },
      },
    },
  }
}

function json<A>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((body) => body as A))
}

function post(directory: string, path: string, body: unknown) {
  return requestInDirectory(path, directory, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

const createSession = Effect.fn("SessionPromptOverflowTest.createSession")(function* (directory: string) {
  const response = yield* post(directory, "/session", {
    title: "Pinned",
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  })
  expect(response.status).toBe(200)
  return yield* json<SessionV1.Info>(response)
})

const seedHistory = Effect.fn("SessionPromptOverflowTest.seedHistory")(function* (
  directory: string,
  sessionID: SessionID,
  marker: string,
) {
  const store = yield* InstanceStore.Service
  yield* store.provide(
    { directory },
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID,
        agent: "build",
        model,
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: user.id,
        sessionID,
        type: "text",
        text: `${marker}\n${"x".repeat(280_000)}`,
      })
      const assistant: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: user.id,
        sessionID,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: directory, root: directory },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: model.modelID,
        providerID: model.providerID,
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      }
      yield* sessions.updateMessage(assistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID,
        type: "text",
        text: "old answer",
      })
    }),
  )
})

const readMessages = Effect.fn("SessionPromptOverflowTest.readMessages")(function* (
  directory: string,
  sessionID: SessionID,
) {
  const store = yield* InstanceStore.Service
  return yield* store.provide({ directory }, SessionNs.use.messages({ sessionID }))
})

function defer() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

it.live(
  "POST /message preserves reviewer-shaped input through one preflight compaction",
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const directory = yield* tmpdirScoped({ git: true, config: overflowConfig(llm.url) })
    const session = yield* createSession(directory)
    const sessionID = SessionID.make(session.id)
    const oldMarker = "api-message-old-history-marker"
    const systemMarker = "api-message-system-marker"
    const firstPart = "api-message-first-part"
    const secondPart = "api-message-second-part"
    const summaryMarker = "api-message-summary-marker"

    yield* seedHistory(directory, sessionID, oldMarker)
    yield* llm.text(summaryMarker)
    yield* llm.tool("StructuredOutput", { review: "accepted" })

    const response = yield* post(directory, `/session/${session.id}/message`, {
      agent: "build",
      model,
      system: systemMarker,
      tools: { bash: true },
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { review: { type: "string" } },
          required: ["review"],
          additionalProperties: false,
        },
        retryCount: 0,
      },
      parts: [
        { type: "text", text: firstPart },
        { type: "text", text: secondPart },
      ],
    })

    const responseBody = yield* response.text
    expect({ status: response.status, body: responseBody }).toMatchObject({ status: 200 })
    const result = JSON.parse(responseBody) as SessionV1.WithParts
    const messages = yield* readMessages(directory, sessionID)
    const hits = yield* llm.hits
    const summaryBody = JSON.stringify(hits[0]?.body)
    const finalBody = JSON.stringify(hits[1]?.body)

    expect(hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
    expect(summaryBody).toContain(oldMarker)
    expect(summaryBody).not.toContain(firstPart)
    expect(finalBody).toContain(summaryMarker)
    expect(finalBody).toContain(systemMarker)
    expect(finalBody).toContain(firstPart)
    expect(finalBody).toContain(secondPart)
    expect(finalBody).toContain("bash")
    expect(finalBody).toContain("StructuredOutput")
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.time.completed).toBeNumber()
      expect(result.info.error).toBeUndefined()
      expect(result.info.structured).toEqual({ review: "accepted" })
    }
    expect(messages.flatMap((message) => message.parts).filter((part) => part.type === "compaction")).toHaveLength(1)
    expect(messages.filter((message) => message.info.role === "assistant" && message.info.summary)).toHaveLength(1)
  }).pipe(Effect.provide(TestLLMServer.layer)),
  20_000,
)

it.live(
  "POST /prompt_async returns 204 before one preflight compaction completes",
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const directory = yield* tmpdirScoped({ git: true, config: overflowConfig(llm.url) })
    const session = yield* createSession(directory)
    const sessionID = SessionID.make(session.id)
    const oldMarker = "api-async-old-history-marker"
    const currentMarker = "api-async-current-marker"
    const summaryMarker = "api-async-summary-marker"
    const answerMarker = "api-async-answer-marker"
    const gate = defer()
    yield* Effect.addFinalizer(() => Effect.sync(gate.resolve))

    yield* seedHistory(directory, sessionID, oldMarker)
    yield* llm.text(summaryMarker)
    yield* llm.hold(answerMarker, gate.promise)

    const response = yield* post(directory, `/session/${session.id}/prompt_async`, {
      parts: [{ type: "text", text: currentMarker }],
    })

    expect(response.status).toBe(204)
    yield* awaitWithTimeout(llm.wait(2), "prompt_async did not reach the post-compaction request", "5 seconds")
    gate.resolve()

    const completed = yield* pollWithTimeout(
      Effect.gen(function* () {
        const messagesResponse = yield* requestInDirectory(`/session/${session.id}/message`, directory)
        const messages = yield* json<SessionV1.WithParts[]>(messagesResponse)
        return messages.some(
          (message) =>
            message.info.role === "assistant" &&
            message.info.finish === "stop" &&
            message.parts.some((part) => part.type === "text" && part.text === answerMarker),
        )
          ? messages
          : undefined
      }),
      "prompt_async did not persist the final assistant",
      "10 seconds",
    )
    const hits = yield* llm.hits
    const summaryBody = JSON.stringify(hits[0]?.body)
    const finalBody = JSON.stringify(hits[1]?.body)

    expect(hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
    expect(summaryBody).toContain(oldMarker)
    expect(summaryBody).not.toContain(currentMarker)
    expect(finalBody).toContain(summaryMarker)
    expect(finalBody).toContain(currentMarker)
    expect(completed.flatMap((message) => message.parts).filter((part) => part.type === "compaction")).toHaveLength(1)
    expect(completed.filter((message) => message.info.role === "assistant" && message.info.summary)).toHaveLength(1)
  }).pipe(Effect.provide(TestLLMServer.layer)),
  20_000,
)
