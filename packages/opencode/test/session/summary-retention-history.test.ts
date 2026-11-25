import path from "node:path"
import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { FastCheck } from "effect/testing"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MessageTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { SessionRestoration } from "@/session/restoration"
import { ProviderTest } from "../fake/provider"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Agent.node,
      Session.node,
      SessionProjector.node,
      Database.node,
      EventV2Bridge.node,
      CrossSpawnSpawner.node,
      FSUtil.node,
    ]),
  ),
)
const model = ProviderTest.model()

const transcript = Effect.fnUntraced(function* () {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ permission: [{ permission: "read", pattern: "*", action: "allow" }] })
  let created = Date.now()
  const user = Effect.fnUntraced(function* () {
    const id = MessageID.ascending()
    yield* sessions.updateMessage({
      id,
      sessionID: chat.id,
      role: "user",
      agent: "build",
      model: { providerID: model.providerID, modelID: model.id },
      time: { created: created++ },
    })
    return id
  })
  const marker = Effect.fnUntraced(function* (anchor?: MessageID) {
    const id = yield* user()
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: id,
      sessionID: chat.id,
      type: "compaction",
      auto: false,
      ...(anchor ? { tail_start_id: anchor } : {}),
    })
    return id
  })
  const assistant = Effect.fnUntraced(function* (
    parentID: MessageID,
    state: "ordinary" | "success" | "unfinished" | "error",
    n?: number,
  ) {
    const id = MessageID.ascending()
    yield* sessions.updateMessage({
      id,
      sessionID: chat.id,
      parentID,
      role: "assistant",
      agent: "build",
      mode: "build",
      providerID: model.providerID,
      modelID: model.id,
      path: { root: "/", cwd: "/" },
      time: { created: created++ },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      summary: state !== "ordinary",
      finish: state === "unfinished" ? undefined : state === "error" ? "error" : "stop",
      ...(state === "error" ? { error: new SessionV1.OutputLengthError({}).toObject() } : {}),
      ...(n === undefined ? {} : { n }),
    })
    return id
  })
  return { id: chat.id, user, marker, assistant }
})

it.instance(
  "PBT: mixed summary generations replay their original IDs across retries and arrivals without upgrading SQLite",
  () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const run = Effect.runPromiseWith(yield* Effect.context<Session.Service | Database.Service>())
      const cycle = FastCheck.record({
        format: FastCheck.constantFrom("legacy-anchor", "legacy-full", "new-zero", "new-three"),
        before: FastCheck.integer({ min: 0, max: 2 }),
        arrivals: FastCheck.integer({ min: 1, max: 3 }),
        failure: FastCheck.constantFrom("error" as const, "unfinished" as const),
      })
      yield* Effect.promise(() =>
        FastCheck.assert(
          FastCheck.asyncProperty(FastCheck.array(cycle, { minLength: 2, maxLength: 4 }), (cycles) =>
            run(
              Effect.gen(function* () {
                const h = yield* transcript()
                // This list is recorded by the event producer. It contains original
                // messages only, so neither a failed attempt nor a previous marker can
                // make up one of the three expected retained rows.
                const originals = yield* Effect.forEach([0, 1, 2], () => h.user())
                let visible = [...originals]
                for (const cycle of cycles) {
                  for (let i = 0; i < cycle.before; i++) {
                    const id = yield* h.assistant(originals.at(-1)!, "ordinary")
                    originals.push(id)
                    visible.push(id)
                  }
                  // An old marker could point to a hidden attempt; the old reader
                  // began its interval there and then filtered the attempt itself.
                  const hiddenAnchor = yield* h.assistant(originals.at(-1)!, "error")
                  const adjacent = yield* h.user()
                  originals.push(adjacent)
                  visible.push(adjacent)
                  const n = cycle.format === "new-zero" ? 0 : cycle.format === "new-three" ? 3 : undefined
                  const keep = n ?? (cycle.format === "legacy-anchor" ? 1 : 0)
                  const retained = keep ? originals.slice(-keep) : []
                  // Obsolete anchor data intentionally disagrees with both explicit counts.
                  const marker = yield* h.marker(cycle.format === "legacy-full" ? undefined : hiddenAnchor)
                  yield* h.assistant(marker, cycle.failure, 3)
                  const late = yield* Effect.forEach(Array.from({ length: cycle.arrivals }), () => h.user())
                  const pending = yield* MessageV2.filterCompactedEffect(h.id)
                  expect(pending.map((m) => m.info.id)).toEqual([...visible, marker, ...late])

                  const summary = yield* h.assistant(marker, "success", n)
                  const after = yield* h.user()
                  visible = [marker, summary, ...retained, ...late, after]
                  originals.push(...late, after)
                  const active = yield* MessageV2.filterCompactedEffect(h.id)
                  expect(active.map((m) => m.info.id)).toEqual(visible)
                  expect(active[1]?.info).toMatchObject({ n: keep })
                  const stored = yield* db
                    .select({ data: MessageTable.data })
                    .from(MessageTable)
                    .where(eq(MessageTable.id, summary))
                    .get()
                    .pipe(Effect.orDie)
                  expect(stored).toBeDefined()
                  if (n === undefined) expect(stored!.data).not.toHaveProperty("n")
                  else expect(stored!.data).toMatchObject({ n })
                }
              }),
            ),
          ),
          {
            seed: 600316,
            numRuns: 24,
            examples: [
              [
                [
                  { format: "legacy-anchor", before: 2, arrivals: 2, failure: "error" },
                  { format: "new-three", before: 0, arrivals: 1, failure: "unfinished" },
                  { format: "new-zero", before: 1, arrivals: 1, failure: "error" },
                  { format: "legacy-full", before: 1, arrivals: 2, failure: "unfinished" },
                ],
              ],
            ],
          },
        ),
      )
    }),
  30_000,
)

it.instance("restoration deduplicates only files already visible inside the successful summary's counted tail", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const fs = yield* FSUtil.Service
    const dir = (yield* TestInstance).directory
    const h = yield* transcript()
    const saved = Effect.fnUntraced(function* (file: string, body: string) {
      const user = yield* h.user()
      const assistant = yield* h.assistant(user, "ordinary")
      const filePath = path.join(dir, file)
      yield* fs.writeWithDirs(filePath, body)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant,
        sessionID: h.id,
        type: "tool",
        tool: "read",
        callID: PartID.ascending(),
        state: {
          status: "completed",
          input: { filePath },
          title: file,
          output: body.split("\n").map((line, index) => `${index + 1}: ${line}`).join("\n"),
          metadata: {
            display: {
              path: filePath,
              type: "file",
              text: body,
              sha256: Bun.SHA256.hash(body, "hex"),
              truncated: false,
              lineStart: 1,
              lineEnd: body.split("\n").length,
              totalLines: body.split("\n").length,
            },
          },
          time: { start: 0, end: 1 },
        },
      })
      return [user, assistant]
    })
    yield* saved("older.md", "OLDER_FILE_BODY")
    const keep = [
      ...(yield* saved("tail.md", "RETAINED_FILE_BODY")),
      ...(yield* saved("shrunk.md", "first line\nsecond line")),
      ...(yield* saved("cleared.md", "remove contents")),
      ...(yield* saved("other.md", "version on another path")),
    ]
    yield* fs.writeWithDirs(path.join(dir, "shrunk.md"), "first line")
    yield* fs.writeWithDirs(path.join(dir, "cleared.md"), "")
    yield* fs.writeWithDirs(path.join(dir, "other.md"), "RETAINED_FILE_BODY")
    const last = yield* h.user()
    const marker = yield* h.marker()
    const summary = yield* h.assistant(marker, "success", keep.length + 1)
    const late = yield* h.user()
    yield* SessionRestoration.apply({ sessionID: h.id })
    const active = yield* MessageV2.filterCompactedEffect(h.id)
    expect(active.map((m) => m.info.id)).toEqual([marker, summary, ...keep, last, late])
    const wire = yield* MessageV2.toModelMessagesEffect(active, model)
    const tool = JSON.stringify(wire.filter((m) => m.role === "tool"))
    const user = JSON.stringify(wire.filter((m) => m.role === "user"))
    expect(tool).toContain("RETAINED_FILE_BODY")
    const blocks = active.flatMap((message) => message.parts).filter((p) => p.type === "text" && SessionRestoration.isRestoration(p))
    expect(blocks).toHaveLength(1)
    const block = blocks[0]
    if (block?.type !== "text") throw new Error("missing restoration text")
    expect(block.text).not.toContain("### " + path.join(dir, "tail.md"))
    for (const [name, body] of [["shrunk.md", "first line"], ["cleared.md", ""], ["other.md", "RETAINED_FILE_BODY"]] as const) {
      expect(block.text).toContain(`### ${path.join(dir, name)}\n\`\`\`\n${body}\n\`\`\``)
    }
    expect(user).toContain("OLDER_FILE_BODY")
    expect(JSON.stringify(wire).match(/(?:RETAINED|OLDER)_FILE_BODY/g)).toHaveLength(3)
  }),
)

it.instance(
  "a recorded count uses raw originals across prior full summaries and excludes their markers and attempts",
  () =>
    Effect.gen(function* () {
      const h = yield* transcript()
      const prior = yield* Effect.forEach([0, 1, 2], () => h.user())
      const old = yield* h.marker()
      yield* h.assistant(old, "success")
      const recent = yield* h.user()
      const marker = yield* h.marker()
      yield* h.assistant(marker, "unfinished", 3)
      const late = yield* h.user()
      const summary = yield* h.assistant(marker, "success", 3)
      const expected = [marker, summary, prior[1]!, prior[2]!, recent, late]
      expect((yield* MessageV2.filterCompactedEffect(h.id)).map((m) => m.info.id)).toEqual(expected)
    }),
)

it.instance(
  "a legacy anchor several SQLite pages away is normalized on each load without changing the summary row",
  () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const h = yield* transcript()
      const users = yield* Effect.forEach(Array.from({ length: 104 }), () => h.user())
      const marker = yield* h.marker(users[1])
      const late = yield* h.user()
      const summary = yield* h.assistant(marker, "success")
      for (let load = 0; load < 2; load++) {
        const active = yield* MessageV2.filterCompactedEffect(h.id)
        expect(active.map((m) => m.info.id)).toEqual([marker, summary, ...users.slice(1), late])
        expect(active[1]?.info).toMatchObject({ n: 103 })
      }
      const persisted = yield* db
        .select({ data: MessageTable.data })
        .from(MessageTable)
        .where(eq(MessageTable.id, summary))
        .get()
        .pipe(Effect.orDie)
      expect(persisted).toBeDefined()
      expect(persisted!.data).not.toHaveProperty("n")
    }),
)

it.instance("an old anchor spanning a successful marker counts only the original messages in its interval", () =>
  Effect.gen(function* () {
    const h = yield* transcript()
    const a = yield* h.user()
    yield* h.assistant(a, "ordinary")
    const first = yield* h.marker()
    yield* h.assistant(first, "success")
    yield* h.user()
    const second = yield* h.marker(a)
    const success = yield* h.assistant(second, "success")
    const active = yield* MessageV2.filterCompactedEffect(h.id)
    expect(active[1]?.info).toMatchObject({ id: success, n: 3 })
  }),
)

it.instance("a fork remaps both the recovery marker and its continuation to the forked user", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const h = yield* transcript()
    const source = yield* h.user()
    const marker = yield* h.marker()
    const part = (yield* MessageV2.get({ sessionID: h.id, messageID: marker })).parts[0]
    if (part?.type !== "compaction") throw new Error("expected a compaction marker")
    yield* sessions.updatePart({ ...part, overflow: true, protected_from: source, request_user_id: source })
    yield* h.assistant(marker, "success", 1)
    const continuation = yield* h.user()
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: h.id,
      messageID: continuation,
      type: "text",
      text: "Continue",
      synthetic: true,
      metadata: { compaction_continue: true, protected_from: source },
    })

    const fork = yield* sessions.fork({ sessionID: h.id })
    const rows = yield* sessions.messages({ sessionID: fork.id })
    const forkedUser = rows[0]!.info.id
    expect(forkedUser).not.toBe(source)
    expect(rows[1]?.parts[0]).toMatchObject({ type: "compaction", protected_from: forkedUser, request_user_id: forkedUser })
    expect(rows[3]?.parts[0]).toMatchObject({
      type: "text",
      metadata: { compaction_continue: true, protected_from: forkedUser },
    })
    expect((yield* MessageV2.get({ sessionID: h.id, messageID: continuation })).parts[0]).toMatchObject({
      metadata: { protected_from: source },
    })
  }),
)

it.instance("fork keeps the calibration sample exactly when its source message is copied", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const h = yield* transcript()
    const source = yield* h.user()
    const measured = yield* h.assistant(source, "ordinary")
    const next = yield* h.user()
    yield* sessions.updateMetadata({
      sessionID: h.id,
      update: () => ({ label: "unchanged", summaryBudgetSample: { messageID: measured, estimate: 1000 } }),
    })
    for (const boundary of [undefined, next, measured, source]) {
      const child = yield* sessions.fork({ sessionID: h.id, messageID: boundary })
      const assistant = (yield* sessions.messages({ sessionID: child.id })).find((m) => m.info.role === "assistant")
      expect(child.metadata?.label).toBe("unchanged")
      expect(child.metadata?.summaryBudgetSample).toEqual(assistant ? { messageID: assistant.info.id, estimate: 1000 } : undefined)
    }
    expect((yield* sessions.get(h.id)).metadata?.summaryBudgetSample.messageID).toBe(measured)
  }),
)
