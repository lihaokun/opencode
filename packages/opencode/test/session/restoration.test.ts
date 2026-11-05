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
      metadata: { display: { type: "file", path: filePath } },
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
  // The settled marker needs a completed summary pointing at it (#77 guard):
  // restore() only triggers for markers with summary && finish && !error.
  yield* ssn.updateMessage({
    id: MessageID.ascending(),
    parentID: user.id,
    role: "assistant",
    sessionID,
    mode: "compaction",
    agent: "compaction",
    summary: true,
    finish: "stop",
    path: { cwd: filePath, root: filePath },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test"),
    time: { created: Date.now() },
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
      {
        info: { id: "a" },
        parts: [
          toolPart("read", { display: { type: "file", path: "/f/one" } }),
          toolPart("read", { display: { type: "directory", path: "/f/dir" } }),
          toolPart("read", { display: { type: "file", path: "/f/two" } }),
        ],
      },
      {
        info: { id: "b" },
        parts: [
          toolPart("read", { display: { type: "file", path: "/f/one" } }),
          toolPart("edit", { filediff: { file: "/f/one" } }),
          toolPart("skill", { name: "pdf" }),
        ],
      },
    ] as unknown as SessionV1.WithParts[]

    const candidates = collectCandidates(messages, [])
    expect(candidates.map((c) => `${c.kind}:${c.ref}`)).toStrictEqual([
      "skill:pdf",
      "file:/f/one",
      "file:/f/two",
    ])

    // Self-audit P3-b: the todo candidate carries the HIGHEST lastUseSeq
    // (seq + 1) and is the cheapest material — it must ride at the TOP of the
    // descending sort, not be appended after it. Appending processed it last,
    // so any budget pressure degraded the whole current todo list first.
    const withTodos = collectCandidates(messages, [{ content: "ship it" } as Todo.Info])
    expect(withTodos[0]).toMatchObject({ kind: "todo", ref: "todo" })
    expect(withTodos.slice(1).map((c) => `${c.kind}:${c.ref}`)).toStrictEqual([
      "skill:pdf",
      "file:/f/one",
      "file:/f/two",
    ])
  }),
)

it.effect("todo survives budget pressure that degrades files to references", () =>
  Effect.gen(function* () {
    // P3-b: the todo rides first (highest lastUseSeq, cheapest material), so
    // budget pressure that degrades files still inlines the todo list; and
    // should the todo itself ever degrade, its reason must not point at a
    // nonexistent read-tool path (there is no todo-reading tool).
    const todos = [{ content: "ship it" }] as unknown as Todo.Info[]
    const tight = { ...cfg, budget_tokens: 10 }
    const order = collectCandidates(
      [
        {
          info: { id: "m" },
          parts: [{ type: "tool", tool: "read", state: { status: "completed", metadata: { display: { type: "file", path: "/f/big" } } } }] as unknown as SessionV1.Part,
        },
      ] as unknown as SessionV1.WithParts[],
      todos,
    )
    expect(order[0]).toMatchObject({ kind: "todo" })

    // A budget too small for any file still inlines the todo (it is tiny and
    // processed first); the file's degradation keeps the read-tool guidance,
    // which IS honest for files.
    const materials = yield* materializeCandidates(order, "", {
      fs: {
        stat: () => Effect.succeed({ type: "File", size: 100_000 }),
        readFileStringSafe: () => Effect.succeed("x".repeat(100_000)),
      } as unknown as FSUtil.Interface,
      skill: Option.none(),
      todos,
      cfg: tight,
    })
    expect(materials[0]).toMatchObject({ candidate: { kind: "todo" }, status: "inlined" })
    expect(JSON.stringify(materials[0])).toContain("ship it")
    const fileMaterial = materials.find((m) => m.candidate.kind === "file")!
    expect(fileMaterial.status).toBe("reference")
    expect(fileMaterial.reason).toContain("read it with the read tool")
    // The todo's own degradation reason (forced here via an already-exhausted
    // budget path in renderMaterials) no longer mentions the read tool.
    const rendered = renderMaterials(
      [
        ...materials,
        { candidate: { kind: "todo", ref: "todo", lastUseSeq: 99 }, status: "inlined", content: JSON.stringify(todos) },
        { candidate: { kind: "todo", ref: "todo", lastUseSeq: 99 }, status: "reference", reason: "restoration budget exhausted; the todo list was not re-inlined" },
      ],
      tight,
    )!
    expect(rendered).toContain("the todo list was not re-inlined")
    expect(rendered).not.toContain("todo (skipped: restoration budget exhausted; read it with the read tool")
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
        metadata: { display: { type: "file", path: `${dir}/body.txt` } },
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
    // Settled marker (#77 guard): a completed summary pointing at the marker.
    yield* ssn.updateMessage({
      id: MessageID.ascending(),
      parentID: user.id,
      role: "assistant",
      sessionID,
      mode: "compaction",
      agent: "compaction",
      summary: true,
      finish: "stop",
      path: { cwd: dir, root: dir },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: Date.now() },
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

// #77: a compaction marker whose summary never completed against it (a retry
// parked the summary on a newer user message, or the summary failed) has no
// completed summary assistant pointing at it. Restoring "before that
// compaction" would stack the block on top of a full, un-compacted history —
// the marker must be settled. A full-summary compaction (tail_start_id
// undefined but a completed summary present) still counts.
it.instance("apply skips an unsettled compaction marker, accepts a full-summary one", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const session = yield* SessionNs.Service.use((ssn) => ssn.create({}))
    yield* seedRestorable(session.id, path.join(test.directory, "body.txt"), "body text\n")
    const ssn = yield* SessionNs.Service
    const unset = (field: "tail_start_id" | "finish") =>
      Effect.gen(function* () {
        const msgs = yield* ssn.messages({ sessionID: session.id })
        for (const msg of msgs) {
          if (field === "tail_start_id") {
            for (const part of msg.parts) {
              if (part.type === "compaction") yield* ssn.updatePart({ ...part, tail_start_id: undefined })
            }
          } else {
            for (const m of msgs) {
              if (m.info.role === "assistant" && m.info.summary) {
                yield* ssn.updateMessage({ ...m.info, finish: undefined })
              }
            }
          }
        }
      })

    // No completed summary pointing at the marker → not settled → no restore.
    yield* unset("finish")
    yield* apply({ sessionID: session.id })
    const before = yield* SessionNs.Service.use((ssn) => ssn.messages({ sessionID: session.id })).pipe(
      Effect.map((all) => all.flatMap((m) => m.parts)),
    )
    expect(
      before.filter((p): p is SessionV1.TextPart => p.type === "text" && p.text.startsWith(RESTORATION_SENTINEL)),
    ).toHaveLength(0)

    // Summary completed (finish restored) → settled → the restoration lands.
    const ssn2 = yield* SessionNs.Service
    const msgs2 = yield* ssn2.messages({ sessionID: session.id })
    for (const m of msgs2) {
      if (m.info.role === "assistant" && m.info.summary) {
        yield* ssn2.updateMessage({ ...m.info, finish: "stop" })
      }
    }
    yield* apply({ sessionID: session.id })
    const after = yield* SessionNs.Service.use((ssn) => ssn.messages({ sessionID: session.id })).pipe(
      Effect.map((all) => all.flatMap((m) => m.parts)),
    )
    const sentinels = after.filter(
      (p): p is SessionV1.TextPart => p.type === "text" && p.text.startsWith(RESTORATION_SENTINEL),
    )
    expect(sentinels.length).toBeGreaterThanOrEqual(1)
    expect(sentinels[0]!.text).toContain("body text")
  }),
)

// III.4 (reviewer 二轮): the full-summary shape — tail_start_id undefined BUT a
// completed summary present — is a legitimate settled marker. The #77 test
// above never exercised unset("tail_start_id") (dead helper branch), so this
// path was untested: restore() must accept it and inject.
it.instance("apply accepts a full-summary marker (tail_start_id undefined)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const session = yield* SessionNs.Service.use((ssn) => ssn.create({}))
    yield* seedRestorable(session.id, path.join(test.directory, "body.txt"), "full summary body\n")
    const ssn = yield* SessionNs.Service
    // Strip tail_start_id from the marker: full-summary fallback shape.
    const msgs = yield* ssn.messages({ sessionID: session.id })
    for (const msg of msgs) {
      for (const part of msg.parts) {
        if (part.type === "compaction") yield* ssn.updatePart({ ...part, tail_start_id: undefined })
      }
    }
    yield* apply({ sessionID: session.id })
    const parts = yield* SessionNs.Service.use((ssn) => ssn.messages({ sessionID: session.id })).pipe(
      Effect.map((all) => all.flatMap((m) => m.parts)),
    )
    const sentinels = parts.filter(
      (p): p is SessionV1.TextPart => p.type === "text" && p.text.startsWith(RESTORATION_SENTINEL),
    )
    expect(sentinels).toHaveLength(1)
    expect(sentinels[0].text).toContain("full summary body")
  }),
)

// R3: the dedup baseline must match what the model actually sees. A read part
// whose output was cleared by compaction (time.compacted set) renders as
// "[Old tool result content cleared]" in the projection — the file body is NOT
// model-visible even though it still sits in storage. buildTailText must skip
// such parts, or a file whose disk body matches only the cleared history would
// be wrongly deduped away and never restored.
it.effect("buildTailText excludes compacted tool outputs from the dedup baseline", () =>
  Effect.gen(function* () {
    const messages = [
      { info: { id: "m1" }, parts: [] },
      {
        info: { id: "m2" },
        parts: [
          {
            type: "tool",
            tool: "read",
            state: { status: "completed", output: "FILE BODY", time: { compacted: 1 } },
          },
          {
            type: "tool",
            tool: "read",
            state: { status: "completed", output: "VISIBLE BODY", time: {} },
          },
        ],
      },
    ] as unknown as SessionV1.WithParts[]

    const tail = buildTailText(messages, "m2")
    expect(tail).toContain("VISIBLE BODY")
    expect(tail).not.toContain("FILE BODY")
  }),
)

// R4: the omitted list is bounded. A thousand historical candidates must not
// produce a Not-restored section measured in multiples of the budget.
it.effect("renderMaterials collapses the not-restored list beyond the cap", () =>
  Effect.sync(() => {
    const candidate = (n: number) => ({ kind: "file" as const, ref: `/gone/${n}`, lastUseSeq: 0 })
    const materials = Array.from({ length: 1_000 }, (_, n) => ({
      candidate: candidate(n),
      status: "missing" as const,
      reason: "file not found on disk",
    }))
    const text = renderMaterials(materials, cfg)!
    expect(text).toContain("...and 980 more (use the read/glob tools if needed)")
    // The whole block stays inside a small multiple of the budget.
    expect(Token.estimate(text)).toBeLessThan(cfg.budget_tokens + 500)
  }),
)

// R3 (reviewer 二轮复现链): apply → filterCompactedEffect → toModelMessagesEffect.
// A read whose stored output was cleared by compaction (time.compacted) but
// whose disk body matches that cleared output: the model must still receive
// the file body via the restoration block — the dedup baseline may not count
// cleared history as visible.
it.instance("restored body reaches the model when the only prior copy was compacted", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const session = yield* SessionNs.Service.use((ssn) => ssn.create({}))
    const sessionID = session.id
    const body = "COMPACTED-ONLY-BODY\n"
    const spec = path.join(test.directory, "spec.md")
    yield* seedRestorable(sessionID, spec, body)

    // A real read tool's output IS the file body — make the stored output
    // match the disk body byte-for-byte (this is what makes the old, buggy
    // dedup matter: tailText.includes(content) would hit the cleared output).
    const ssn0 = yield* SessionNs.Service
    const raw = yield* ssn0.messages({ sessionID })
    for (const msg of raw) {
      for (const part of msg.parts) {
        if (part.type === "tool" && part.tool === "read" && part.state.status === "completed") {
          yield* ssn0.updatePart({
            ...part,
            state: { ...part.state, output: body },
          })
        }
      }
    }

    // Then mark it compacted like a later prune would: storage keeps the
    // output, the projection shows the placeholder instead.
    const ssn = yield* SessionNs.Service
    const seeded = yield* ssn.messages({ sessionID })
    for (const msg of seeded) {
      for (const part of msg.parts) {
        if (part.type === "tool" && part.tool === "read") {
          if (part.state.status === "completed") {
            yield* ssn.updatePart({
              ...part,
              state: { ...part.state, time: { ...part.state.time, compacted: Date.now() } },
            })
          }
        }
      }
    }

    yield* apply({ sessionID })

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

    const active = yield* MessageV2.filterCompactedEffect(sessionID)
    const rendered = yield* MessageV2.toModelMessagesEffect(active, model)
    const wire = JSON.stringify(rendered)
    // The restoration block carries the current disk body...
    expect(wire).toContain(RESTORATION_SENTINEL)
    expect(wire).toContain("COMPACTED-ONLY-BODY")
    // ...and the cleared read renders as the placeholder, not the raw output.
    expect(wire).toContain("[Old tool result content cleared]")
  }),
)

// Self-audit P2-b (G4: at most one restoration block per context): a second
// compaction whose retained tail still holds the first sentinel's carrier
// message used to leave BOTH blocks model-visible — two "Context restored"
// headers, each up to budget_tokens, both claiming to be current. The fresh
// write must retire every prior sentinel (ignored: true, same part id — an
// in-place flip, not an append), and the projection must show exactly one.
it.instance("a second compaction retires the previous restoration block", () =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ssn = yield* SessionNs.Service
    const dir = (yield* TestInstance).directory
    const session = yield* ssn.create({})
    const sessionID = session.id

    // Compaction 1 settles; apply writes sentinel 1 on the marker's message.
    yield* fs.writeWithDirs(`${dir}/one.md`, "FIRST RESTORE BODY\n")
    yield* seedRestorable(sessionID, `${dir}/one.md`, "FIRST RESTORE BODY\n")
    yield* apply({ sessionID })
    const afterFirst = yield* ssn.messages({ sessionID })
    const firstSentinel = afterFirst.flatMap((m) => m.parts).find(
      (p): p is SessionV1.TextPart => p.type === "text" && p.text.startsWith(RESTORATION_SENTINEL),
    )
    if (!firstSentinel) throw new Error("expected the first restoration block")

    // Compaction 2: a NEW marker+summary pair, retained tail anchored at the
    // first marker's message — the exact shape that keeps sentinel 1 inside
    // the model-visible window. A different file gives the second block
    // different content, so the byte-dedup cannot suppress the write.
    yield* fs.writeWithDirs(`${dir}/two.md`, "SECOND RESTORE BODY\n")
    const marker2 = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
      time: { created: Date.now() },
    })
    // A read of the second file rides an assistant message in the retained
    // region so collectCandidates picks it up.
    const assistant2 = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      parentID: marker2.id,
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
      messageID: assistant2.id,
      sessionID,
      type: "tool",
      tool: "read",
      callID: "call_two",
      state: {
        status: "completed",
        input: { filePath: `${dir}/two.md` },
        output: `read ${dir}/two.md`,
        title: "two.md",
        metadata: { display: { type: "file", path: `${dir}/two.md` } },
        time: { start: 0, end: 1 },
      },
    })
    yield* ssn.updatePart({
      id: PartID.ascending(),
      messageID: marker2.id,
      sessionID,
      type: "compaction",
      auto: false,
      // Anchor the retained tail at the FIRST marker's turn: seedRestorable's
      // messages stay visible, sentinel 1 with them.
      tail_start_id: afterFirst.find((m) => m.info.role === "user" && m.parts.some((p) => p.type === "compaction"))!
        .info.id,
    })
    yield* ssn.updateMessage({
      id: MessageID.ascending(),
      parentID: marker2.id,
      role: "assistant",
      sessionID,
      mode: "compaction",
      agent: "compaction",
      summary: true,
      finish: "stop",
      path: { cwd: dir, root: dir },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: Date.now() },
    })

    yield* apply({ sessionID })

    // Storage: sentinel 1 still exists (audit trail) but is retired.
    const stored = yield* ssn.messages({ sessionID })
    const storedSentinels = stored.flatMap((m) => m.parts).filter(
      (p): p is SessionV1.TextPart => p.type === "text" && p.text.startsWith(RESTORATION_SENTINEL),
    )
    expect(storedSentinels.length).toBeGreaterThanOrEqual(2)
    expect(storedSentinels.find((p) => p.text.includes("FIRST RESTORE BODY"))?.ignored).toBe(true)

    // Projection: exactly one restoration header reaches the model.
    const active = yield* MessageV2.filterCompactedEffect(sessionID)
    const visible = active.flatMap((m) => m.parts).filter(
      (p): p is SessionV1.TextPart => p.type === "text" && !p.ignored && p.text.startsWith(RESTORATION_SENTINEL),
    )
    expect(visible).toHaveLength(1)
    expect(visible[0].text).toContain("SECOND RESTORE BODY")
  }),
)
