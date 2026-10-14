import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Effect } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { Snapshot } from "@/snapshot"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const layer = LayerNode.compile(
  LayerNode.group([
    EventV2Bridge.node,
    Config.node,
    CrossSpawnSpawner.node,
    FSUtil.node,
    BackgroundJob.node,
    Session.node,
    SessionProjector.node,
    Database.node,
    Snapshot.node,
    SessionSummary.node,
  ]),
  [[InstanceStore.bootstrapNode, InstanceBootstrap.node]],
)

const it = testEffect(layer)
const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
const write = (file: string, content: string) => FSUtil.Service.use((fs) => fs.writeWithDirs(file, content))

// Message order is storage order, by creation time. This machine's clock has
// been seen stepping backwards (journald: "Time jumped backwards"), which once
// filed a later turn before an earlier one; the seeded turns take their times
// from a counter so the test exercises the code, not the clock.
const clock = { now: Date.now() }
const tick = () => (clock.now += 10)

/** One turn: a user message and its assistant reply carrying the two snapshot hashes. */
const seedTurn = Effect.fn("SummaryTest.seedTurn")(function* (
  sessionID: SessionID,
  snapshots?: { from: string; to: string },
) {
  const sessions = yield* Session.Service
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: tick() },
  })
  const assistant = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: tick() },
  })
  if (!snapshots) return user
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "step-start",
    snapshot: snapshots.from,
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "step-finish",
    reason: "stop",
    snapshot: snapshots.to,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  return user
})

const storedDiffs = Effect.fn("SummaryTest.storedDiffs")(function* (sessionID: SessionID, messageID: MessageID) {
  const sessions = yield* Session.Service
  const message = (yield* sessions.messages({ sessionID })).find((item) => item.info.id === messageID)
  if (!message || message.info.role !== "user") throw new Error("user message missing")
  return { info: message.info, diffs: message.info.summary?.diffs ?? [] }
})

describe("SessionSummary", () => {
  // The incident this guards: a turn that regenerated hundreds of tracked log
  // files put 244 MB of patch text into one user message, and the durable
  // message.updated event copied it on every write. The message now holds
  // names and counts; its size no longer follows the size of what changed.
  it.instance(
    "stores names and counts, never the patch, whatever the file size",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const snapshot = yield* Snapshot.Service
        const sessions = yield* Session.Service
        const summary = yield* SessionSummary.Service
        const events = yield* EventV2Bridge.Service
        const from = yield* snapshot.track()
        const lines = 20_000
        yield* write(`${tmp.directory}/big.log`, `${"x".repeat(60)}\n`.repeat(lines))
        yield* write(`${tmp.directory}/small.txt`, "small content\n")
        const to = yield* snapshot.track()
        const session = yield* sessions.create({ title: "summary" })
        const user = yield* seedTurn(session.id, { from: from!, to: to! })
        const published: Snapshot.FileDiff[][] = []
        const off = yield* events.listen((event) => {
          if (event.type === Session.Event.Diff.type) published.push((event.data as { diff: Snapshot.FileDiff[] }).diff)
          return Effect.void
        })

        yield* summary.summarize({ sessionID: session.id, messageID: user.id })
        yield* off

        const { info, diffs } = yield* storedDiffs(session.id, user.id)
        expect(diffs.map((d) => d.file).sort()).toEqual(["big.log", "small.txt"])
        for (const row of diffs) expect("patch" in row).toBe(false)
        expect(diffs.find((d) => d.file === "big.log")).toMatchObject({
          additions: lines,
          deletions: 0,
          status: "added",
        })
        // Two files, 20k lines changed: the message stays a few hundred bytes.
        expect(JSON.stringify(info).length).toBeLessThan(2_000)

        // Session-level counts are this turn's aggregate, and the diff event
        // carries the same list the sidebar lists files from.
        expect((yield* sessions.get(session.id)).summary).toMatchObject({
          files: 2,
          additions: lines + 1,
          deletions: 0,
        })
        expect(published).toHaveLength(1)
        expect(published[0]?.map((d) => d.file).sort()).toEqual(["big.log", "small.txt"])
      }),
    { git: true },
  )

  // The TUI diff viewer asks the endpoint; the patch is computed then, from
  // the same two hashes, and a file over the cap comes back with counts only.
  it.instance(
    "computes the patch on request from the turn's snapshots",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const snapshot = yield* Snapshot.Service
        const sessions = yield* Session.Service
        const summary = yield* SessionSummary.Service
        const from = yield* snapshot.track()
        yield* write(`${tmp.directory}/big.log`, `${"x".repeat(60)}\n`.repeat(20_000))
        yield* write(`${tmp.directory}/small.txt`, "small content\n")
        const to = yield* snapshot.track()
        const session = yield* sessions.create({ title: "summary" })
        const user = yield* seedTurn(session.id, { from: from!, to: to! })
        yield* summary.summarize({ sessionID: session.id, messageID: user.id })

        const diffs = yield* summary.diff({ sessionID: session.id, messageID: user.id })
        expect(diffs.find((d) => d.file === "small.txt")?.patch).toContain("+small content")
        expect(diffs.find((d) => d.file === "big.log")).toMatchObject({ patch: "", additions: 20_000 })
        // Asking did not write anything back.
        for (const row of (yield* storedDiffs(session.id, user.id)).diffs) expect("patch" in row).toBe(false)
      }),
    { git: true },
  )

  // Messages from before this change carry their patches; their snapshot
  // objects may be gone, so what they store is what the viewer gets.
  it.instance("serves a stored patch when the message predates on-demand diffs", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const summary = yield* SessionSummary.Service
      const session = yield* sessions.create({ title: "legacy" })
      const user = yield* seedTurn(session.id)
      yield* sessions.updateMessage({
        ...user,
        summary: {
          additions: 1,
          deletions: 0,
          files: 1,
          diffs: [{ file: "old.ts", additions: 1, deletions: 0, patch: "legacy patch" }],
        },
      })
      const diffs = yield* summary.diff({ sessionID: session.id, messageID: user.id })
      expect(diffs).toEqual([{ file: "old.ts", additions: 1, deletions: 0, patch: "legacy patch" }])
    }),
  )

  // The processor schedules one summary per step and releases them together,
  // and the next run's first step schedules another; the message is written
  // once for all of them.
  it.instance(
    "writes the message once however many summaries are scheduled for it",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const snapshot = yield* Snapshot.Service
        const sessions = yield* Session.Service
        const summary = yield* SessionSummary.Service
        const events = yield* EventV2Bridge.Service
        const from = yield* snapshot.track()
        yield* write(`${tmp.directory}/one.txt`, "one\n")
        const to = yield* snapshot.track()
        const session = yield* sessions.create({ title: "burst" })
        const user = yield* seedTurn(session.id, { from: from!, to: to! })
        let writes = 0
        const off = yield* events.listen((event) => {
          const info = (event.data as { info?: { id?: string } }).info
          if (event.type === "message.updated" && info?.id === user.id) writes += 1
          return Effect.void
        })

        yield* Effect.all(
          Array.from({ length: 6 }, () => summary.summarize({ sessionID: session.id, messageID: user.id })),
          { concurrency: "unbounded" },
        )
        yield* summary.summarize({ sessionID: session.id, messageID: user.id })
        yield* off

        expect(writes).toBe(1)
        expect((yield* storedDiffs(session.id, user.id)).diffs).toEqual([
          { file: "one.txt", additions: 1, deletions: 0, status: "added" },
        ])
      }),
    { git: true },
  )

  // git C-quotes such a name; stored rows, the diff event and the endpoint
  // must all carry the real one, or a client keyed on the name sees two files.
  const quoting = process.platform === "win32" ? it.instance.skip : it.instance
  quoting(
    "stores and serves the real file name when git would quote it",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const snapshot = yield* Snapshot.Service
        const sessions = yield* Session.Service
        const summary = yield* SessionSummary.Service
        const from = yield* snapshot.track()
        yield* write(`${tmp.directory}/q\"uote.txt`, "quoted\n")
        const to = yield* snapshot.track()
        const session = yield* sessions.create({ title: "quoting" })
        const user = yield* seedTurn(session.id, { from: from!, to: to! })
        yield* summary.summarize({ sessionID: session.id, messageID: user.id })
        expect((yield* storedDiffs(session.id, user.id)).diffs.map((d) => d.file)).toEqual(['q"uote.txt'])
        expect((yield* summary.diff({ sessionID: session.id, messageID: user.id })).map((d) => d.file)).toEqual([
          'q"uote.txt',
        ])
      }),
    { git: true },
  )

  // Opening a session, the TUI asks without a message id to fill its file list.
  it.instance(
    "serves the latest turn's names and counts when no message is named",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const snapshot = yield* Snapshot.Service
        const sessions = yield* Session.Service
        const summary = yield* SessionSummary.Service
        const session = yield* sessions.create({ title: "latest" })
        expect(yield* summary.diff({ sessionID: session.id })).toEqual([])

        const a = yield* snapshot.track()
        yield* write(`${tmp.directory}/first.txt`, "first\n")
        const b = yield* snapshot.track()
        const first = yield* seedTurn(session.id, { from: a!, to: b! })
        yield* summary.summarize({ sessionID: session.id, messageID: first.id })
        yield* write(`${tmp.directory}/second.txt`, "second\nline\n")
        const c = yield* snapshot.track()
        const second = yield* seedTurn(session.id, { from: b!, to: c! })
        yield* summary.summarize({ sessionID: session.id, messageID: second.id })

        expect(yield* summary.diff({ sessionID: session.id })).toEqual([
          { file: "second.txt", additions: 2, deletions: 0, status: "added" },
        ])
      }),
    { git: true },
  )

  // A turn that changed nothing must still be written once: that write is what
  // zeroes the session's counts and empties the sidebar left by the turn before.
  it.instance(
    "a later turn with no changes resets the counts and clears the list",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const snapshot = yield* Snapshot.Service
        const sessions = yield* Session.Service
        const summary = yield* SessionSummary.Service
        const events = yield* EventV2Bridge.Service
        const published: Snapshot.FileDiff[][] = []
        const off = yield* events.listen((event) => {
          if (event.type === Session.Event.Diff.type) published.push((event.data as { diff: Snapshot.FileDiff[] }).diff)
          return Effect.void
        })
        const session = yield* sessions.create({ title: "quiet turn" })
        const a = yield* snapshot.track()
        yield* write(`${tmp.directory}/busy.txt`, "busy\n")
        const b = yield* snapshot.track()
        const busy = yield* seedTurn(session.id, { from: a!, to: b! })
        yield* summary.summarize({ sessionID: session.id, messageID: busy.id })
        expect((yield* sessions.get(session.id)).summary).toMatchObject({ files: 1, additions: 1 })

        // Same tree on both sides: nothing changed in this turn.
        const quiet = yield* seedTurn(session.id, { from: b!, to: b! })
        yield* summary.summarize({ sessionID: session.id, messageID: quiet.id })
        yield* summary.summarize({ sessionID: session.id, messageID: quiet.id })
        yield* off

        expect((yield* storedDiffs(session.id, quiet.id)).diffs).toEqual([])
        expect((yield* sessions.get(session.id)).summary).toMatchObject({ files: 0, additions: 0, deletions: 0 })
        expect(yield* summary.diff({ sessionID: session.id })).toEqual([])
        // One event per turn: the busy one, then the empty one; the repeat wrote nothing.
        expect(published.map((list) => list.length)).toEqual([1, 0])
      }),
    { git: true },
  )

  it.instance("has nothing to say for a turn without snapshots", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const summary = yield* SessionSummary.Service
      const session = yield* sessions.create({ title: "no snapshots" })
      const user = yield* seedTurn(session.id)
      yield* summary.summarize({ sessionID: session.id, messageID: user.id })
      expect((yield* storedDiffs(session.id, user.id)).diffs).toEqual([])
      expect(yield* summary.diff({ sessionID: session.id, messageID: user.id })).toEqual([])
    }),
  )
})

// §5.3 layer 3: random turns. The message's size must follow the number of
// files, never their size; what is stored must be what git counted; asking for
// the diff must not change what is stored.
function rng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const textOf = (next: () => number, lines: number, width: number) =>
  Array.from({ length: lines }, () => `${Math.floor(next() * 1e9)} ${"x".repeat(width)}\n`).join("")

describe("SessionSummary random turns", () => {
  it.instance(
    "stores git's counts, stays small whatever the files weigh, and is idempotent",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const snapshot = yield* Snapshot.Service
        const sessions = yield* Session.Service
        const summary = yield* SessionSummary.Service
        for (let n = 0; n < 8; n++) {
          const seed = 7000 + n
          const next = rng(seed)
          const label = `seed ${seed}`
          const count = 1 + Math.floor(next() * 7)
          const from = yield* snapshot.track()
          const big = new Set<string>()
          for (let i = 0; i < count; i++) {
            const file = `t${n}/f${i}.txt`
            const over = next() < 0.2
            if (over) big.add(file)
            yield* write(
              `${tmp.directory}/${file}`,
              over ? textOf(next, 18_000, 60) : textOf(next, 1 + Math.floor(next() * 30), 20),
            )
          }
          const to = yield* snapshot.track()
          if (!from || !to) continue
          const expected = yield* snapshot.diffStat(from, to)
          const session = yield* sessions.create({ title: label })
          const user = yield* seedTurn(session.id, { from, to })

          yield* summary.summarize({ sessionID: session.id, messageID: user.id })
          const first = yield* storedDiffs(session.id, user.id)
          expect(first.diffs, label).toEqual(expected)
          for (const row of first.diffs) expect("patch" in row, label).toBe(false)
          // A few hundred bytes per file, no matter how large the files are.
          expect(JSON.stringify(first.info).length, label).toBeLessThan(400 + 300 * count)
          expect((yield* sessions.get(session.id)).summary, label).toMatchObject({
            files: expected.length,
            additions: expected.reduce((sum, d) => sum + d.additions, 0),
            deletions: expected.reduce((sum, d) => sum + d.deletions, 0),
          })

          // Asking for the diff computes patches from the hashes and writes nothing back.
          const shown = yield* summary.diff({ sessionID: session.id, messageID: user.id })
          expect(
            shown.map((d) => ({ file: d.file, additions: d.additions, deletions: d.deletions })),
            label,
          ).toEqual(expected.map((d) => ({ file: d.file, additions: d.additions, deletions: d.deletions })))
          for (const row of shown) expect(row.patch === "", `${label} ${row.file}`).toBe(big.has(row.file!))
          expect((yield* storedDiffs(session.id, user.id)).diffs, label).toEqual(expected)

          // Summarizing again changes nothing.
          yield* summary.summarize({ sessionID: session.id, messageID: user.id })
          expect((yield* storedDiffs(session.id, user.id)).diffs, label).toEqual(expected)
        }
      }),
    { git: true },
    120_000,
  )

  // Sessions with several turns: naming no message means the latest turn,
  // naming one means that turn, and both report what git counted for it.
  it.instance(
    "random multi-turn sessions: no message id is the latest turn, a message id is its own",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const snapshot = yield* Snapshot.Service
        const sessions = yield* Session.Service
        const summary = yield* SessionSummary.Service
        for (let n = 0; n < 6; n++) {
          const seed = 9000 + n
          const next = rng(seed)
          const label = `seed ${seed}`
          const session = yield* sessions.create({ title: label })
          const turns: { id: MessageID; expected: Snapshot.FileDiff[] }[] = []
          let from = yield* snapshot.track()
          for (let t = 0, count = 1 + Math.floor(next() * 4); t < count; t++) {
            for (let i = 0, files = 1 + Math.floor(next() * 4); i < files; i++) {
              yield* write(`${tmp.directory}/m${n}/t${t}-f${i}.txt`, textOf(next, 1 + Math.floor(next() * 20), 12))
            }
            const to = yield* snapshot.track()
            if (!from || !to) break
            const user = yield* seedTurn(session.id, { from, to })
            yield* summary.summarize({ sessionID: session.id, messageID: user.id })
            turns.push({ id: user.id, expected: yield* snapshot.diffStat(from, to) })
            from = to
          }
          if (!turns.length) continue
          const strip = (d: Snapshot.FileDiff) => ({ file: d.file, additions: d.additions, deletions: d.deletions })
          // Diagnostics for a failure: every user message in storage order, with its
          // creation time and the files its stored summary names.
          const users = (yield* sessions.messages({ sessionID: session.id })).flatMap((m) =>
            m.info.role === "user"
              ? [`${m.info.id}@${m.info.time.created}:${m.info.summary?.diffs?.map((d) => d.file).join("|") ?? "-"}`]
              : [],
          )
          const detail = `${label} turns=${turns.map((t) => t.id).join(",")} users=${users.join(" ")}`
          expect((yield* summary.diff({ sessionID: session.id })).map(strip), detail).toEqual(
            turns[turns.length - 1]!.expected.map(strip),
          )
          for (const turn of turns) {
            expect((yield* summary.diff({ sessionID: session.id, messageID: turn.id })).map(strip), label).toEqual(
              turn.expected.map(strip),
            )
          }
        }
      }),
    { git: true },
    120_000,
  )
})
