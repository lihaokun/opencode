import path from "path"
import { expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { TestConfig } from "../fixture/config"
import { Session as SessionNs } from "@/session/session"
import { Todo } from "../../src/session/todo"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { Token } from "../../src/util/token"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Provider } from "@/provider/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import {
  RESTORATION_SENTINEL,
  apply,
  buildTailText,
  collectCandidates,
  materializeCandidates,
  renderMaterials,
  restorationConfig,
} from "../../src/session/restoration"

const env = AppNodeBuilder.build(
  LayerNode.group([
    SessionNs.node,
    SessionProjector.node,
    Database.node,
    EventV2Bridge.node,
    CrossSpawnSpawner.node,
    FSUtil.node,
  ]),
)
const it = testEffect(env)

const cfg = restorationConfig(undefined)

const seedRestorable = Effect.fn("test.seedRestorable")(function* (
  sessionID: SessionID,
  filePath: string,
  fileBody: string,
) {
  const ssn = yield* SessionNs.Service
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(filePath, fileBody)
  const user = yield* ssn.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
    time: { created: Date.now() },
  })
  const assistant = yield* ssn.updateMessage({
    id: MessageID.ascending(),
    parentID: user.id,
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: filePath, root: filePath },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test"),
    time: { created: Date.now() },
  })
  yield* ssn.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "tool",
    tool: "read",
    callID: "call_seed",
    state: {
      status: "completed",
      input: { filePath },
      output: `read ${filePath}`,
      title: filePath,
      metadata: { display: { path: filePath } },
      time: { start: 0, end: 1 },
    },
  })
  yield* ssn.updatePart({
    id: PartID.ascending(),
    messageID: user.id,
    sessionID,
    type: "compaction",
    auto: false,
    tail_start_id: assistant.id,
  })
})

const configLayer = (info: Record<string, unknown>) =>
  Layer.succeed(
    Config.Service,
    TestConfig.make({ get: () => Effect.succeed(info as ConfigV1.Info) }),
  )
const disabledEnv = Layer.mergeAll(env, configLayer({ compaction: { restoration: { enabled: false } } }))
const tightEnv = Layer.mergeAll(env, configLayer({ compaction: { restoration: { enabled: true, budget_tokens: 30 } } }))
const itDisabled = testEffect(disabledEnv)
const itTight = testEffect(tightEnv)

it.effect("buildTailText joins everything from the tail anchor onward", () =>
  Effect.gen(function* () {
    expect(buildTailText([], undefined)).toBe("")

    const messages = [
      { info: { id: "m1" }, parts: [{ type: "text", text: "early" }] },
      { info: { id: "m2" }, parts: [{ type: "text", text: "kept" }] },
      {
        info: { id: "m3" },
        parts: [
          {
            type: "tool",
            tool: "bash",
            state: { status: "completed", output: "out" },
          },
        ],
      },
    ] as unknown as SessionV1.WithParts[]

    expect(buildTailText(messages, undefined)).toBe("")
    expect(buildTailText(messages, "m_missing")).toBe("")
    expect(buildTailText(messages, "m2")).toBe("kept\n\nout")
  }),
)

it.effect("collectCandidates keeps the most recent ref and appends todos", () =>
  Effect.gen(function* () {
    const toolPart = (tool: string, metadata: unknown) =>
      ({
        type: "tool",
        tool,
        state: { status: "completed", metadata },
      }) as unknown as SessionV1.Part

    const messages = [
      { info: { id: "a" }, parts: [toolPart("read", { display: { path: "/f/one" } }), toolPart("read", { display: { path: "/f/two" } })] },
      { info: { id: "b" }, parts: [toolPart("read", { display: { path: "/f/one" } }), toolPart("edit", { filepath: "/f/one" }), toolPart("skill", { name: "pdf" })] },
    ] as unknown as SessionV1.WithParts[]

    const candidates = collectCandidates(messages, [])
    expect(candidates.map((c) => `${c.kind}:${c.ref}`)).toStrictEqual([
      "skill:pdf",
      "file:/f/one",
      "file:/f/two",
    ])

    const withTodos = collectCandidates(messages, [{ content: "ship it" } as Todo.Info])
    expect(withTodos.at(-1)).toMatchObject({ kind: "todo", ref: "todo" })
  }),
)

it.instance("materializeCandidates covers inlined, duplicate, missing and reference", () =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const dir = (yield* TestInstance).directory
    const body = "FILE BODY\n"
    yield* fs.writeWithDirs(`${dir}/small.txt`, body)
    yield* fs.writeWithDirs(`${dir}/big.txt`, "b".repeat(17_000))

    const candidates = [
      { kind: "file" as const, ref: `${dir}/small.txt`, lastUseSeq: 1 },
      { kind: "file" as const, ref: `${dir}/missing.txt`, lastUseSeq: 2 },
      { kind: "file" as const, ref: `${dir}/big.txt`, lastUseSeq: 3 },
      { kind: "todo" as const, ref: "todo", lastUseSeq: 4 },
    ]
    const materials = yield* materializeCandidates(candidates, "FILE BODY\n is already in the tail", {
      fs,
      skill: Option.none(),
      todos: [{ content: "ship it" } as Todo.Info],
      cfg,
    })

    expect(materials.map((m) => m.status)).toStrictEqual([
      "skipped-duplicate",
      "missing",
      "reference",
      "inlined",
    ])
    expect(materials[0].reason).toContain("retained tail")
    expect(materials[1].reason).toContain("not found")
    expect(materials[2].reason).toContain("cap")
    expect(materials[3].content).toContain("ship it")
  }),
)

it.effect("renderMaterials applies budget, max_files and the sentinel", () =>
  Effect.gen(function* () {
    const candidate = (ref: string) => ({ kind: "file" as const, ref, lastUseSeq: 0 })
    const inlined = (ref: string, content: string) => ({
      candidate: candidate(ref),
      status: "inlined" as const,
      content,
    })

    // everything skipped -> undefined
    expect(
      renderMaterials([{ candidate: candidate("x"), status: "skipped-duplicate" }], cfg),
    ).toBeUndefined()

    // budget exhaustion degrades later files to reference lines
    const costA = Token.estimate("x".repeat(200))
    const tight = { ...cfg, budget_tokens: costA + 1, max_files: 10 }
    const text = renderMaterials(
      [inlined("/a", "x".repeat(200)), inlined("/b", "y".repeat(200))],
      tight,
    )!
    expect(text).toContain(RESTORATION_SENTINEL)
    expect(text).toContain("### /a")
    expect(text).not.toContain("### /b")
    expect(text).toContain("/b (skipped: restoration budget exhausted")

    // max_files caps inlined files
    const capped = renderMaterials(
      [inlined("/1", "one"), inlined("/2", "two"), inlined("/3", "three")],
      { ...cfg, max_files: 2, budget_tokens: 1_000 },
    )!
    expect(capped).toContain("### /1")
    expect(capped).toContain("### /2")
    expect(capped).not.toContain("### /3")
    expect(capped).toContain("beyond max_files=2")
  }),
)

it.instance("apply writes one restoration part and stays idempotent", () =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ssn = yield* SessionNs.Service
    const dir = (yield* TestInstance).directory
    const session = yield* ssn.create({})
    const sessionID = session.id
    const body = "FILE BODY\n"
    yield* fs.writeWithDirs(`${dir}/body.txt`, body)

    const user = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
      time: { created: Date.now() },
    })
    const assistant = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      parentID: user.id,
      role: "assistant",
      sessionID,
      mode: "build",
      agent: "build",
      path: { cwd: dir, root: dir },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: Date.now() },
    })
    yield* ssn.updatePart({
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID,
      type: "tool",
      tool: "read",
      callID: "call_restore",
      state: {
        status: "completed",
        input: { filePath: `${dir}/body.txt` },
        output: `read ${dir}/body.txt`,
        title: "body.txt",
        metadata: { display: { path: `${dir}/body.txt` } },
        time: { start: 0, end: 1 },
      },
    })
    // compaction anchored at the assistant message: the tail starts there, so the
    // file body itself is not verbatim in the tail (only the tool output text is
    // the body here, so use a distinct on-disk body vs output to force inlined)
    yield* ssn.updatePart({
      id: PartID.ascending(),
      messageID: user.id,
      sessionID,
      type: "compaction",
      auto: false,
      tail_start_id: assistant.id,
    })

    yield* apply({ sessionID })
    yield* apply({ sessionID })

    const messages = yield* ssn.messages({ sessionID })
    const sentinels = messages
      .flatMap((m) => m.parts)
      .filter((p): p is SessionV1.TextPart => p.type === "text" && p.text.startsWith(RESTORATION_SENTINEL))
    expect(sentinels).toHaveLength(1)
    expect(sentinels[0].synthetic).toBe(true)
    expect(sentinels[0].text).toContain("FILE BODY")
    expect(sentinels[0].text).toContain("## Files")
  }),
)

it.instance("restored part reaches the model messages", () =>
  Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    const session = yield* ssn.create({})
    const sessionID = session.id
    const user = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
      time: { created: Date.now() },
    })
    yield* ssn.updatePart({
      id: PartID.ascending(),
      messageID: user.id,
      sessionID,
      type: "text",
      text: "continue the work",
      synthetic: true,
    })
    yield* ssn.updatePart({
      id: PartID.ascending(),
      messageID: user.id,
      sessionID,
      type: "text",
      text: `${RESTORATION_SENTINEL}\nContext restored from before the last compaction:\n\n## Todos\n\`\`\`\n[]\n\`\`\``,
      synthetic: true,
    })

    const model = {
      id: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make("test"),
      api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai" },
      name: "Test Model",
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 0, input: 0, output: 0 },
    } as Provider.Model

    const msgs = yield* ssn.messages({ sessionID })
    const rendered = yield* MessageV2.toModelMessagesEffect(msgs, model)
    expect(JSON.stringify(rendered)).toContain(RESTORATION_SENTINEL)
  }),
)


itDisabled.instance("apply respects restoration.enabled = false", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const session = yield* SessionNs.Service.use((ssn) => ssn.create({}))
    yield* seedRestorable(session.id, path.join(test.directory, "body.txt"), "body text\n")
    yield* apply({ sessionID: session.id })
    yield* apply({ sessionID: session.id })
    const parts = yield* SessionNs.Service.use((ssn) => ssn.messages({ sessionID: session.id })).pipe(
      Effect.map((msgs) => msgs.flatMap((m) => m.parts)),
    )
    const sentinels = parts.filter(
      (p): p is SessionV1.TextPart => p.type === "text" && p.text.startsWith(RESTORATION_SENTINEL),
    )
    expect(sentinels).toHaveLength(0)
  }),
)

itTight.instance("apply degrades to a reference under a tight budget", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const session = yield* SessionNs.Service.use((ssn) => ssn.create({}))
    const body = "y".repeat(200)
    yield* seedRestorable(session.id, path.join(test.directory, "body.txt"), body)
    yield* apply({ sessionID: session.id })
    const parts = yield* SessionNs.Service.use((ssn) => ssn.messages({ sessionID: session.id })).pipe(
      Effect.map((msgs) => msgs.flatMap((m) => m.parts)),
    )
    const sentinels = parts.filter(
      (p): p is SessionV1.TextPart => p.type === "text" && p.text.startsWith(RESTORATION_SENTINEL),
    )
    expect(sentinels).toHaveLength(1)
    expect(sentinels[0].text).toContain("restoration budget exhausted")
    expect(sentinels[0].text).not.toContain(body)
  }),
)
