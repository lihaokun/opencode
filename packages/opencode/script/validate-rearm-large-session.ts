/**
 * Query benchmark for #85's performance half: on a session with 20k
 * persisted messages, the re-arm predicate (hasUnconsumedTurn) must cost
 * milliseconds, not seconds. Fills a real SQLite database inside a tmpdir
 * instance, then times both predicate implementations against it:
 *
 *   1. bulk-fill the session with ~20k messages (real DB writes)
 *   2. OLD: MessageV2.filterCompactedEffect — the full-load predicate
 *      (paged stream + hydrate of every message's parts)
 *   3. NEW: MessageV2.latestRole — the single indexed row the fixed
 *      hasUnconsumedTurn runs inside finishRun's critical section
 *
 * This is a query benchmark, not a full prompt.loop run: the loop's
 * end-to-end behavior is covered by the runner/run-state regression suites;
 * what needed one-off measurement was the predicate's cost at incident
 * scale. Prints timings; asserts the new predicate stays under 500ms.
 */
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect } from "effect"
import { MessageID, PartID } from "@/session/schema"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { withTmpdirInstance } from "../test/fixture/fixture"

const COUNT = Number(process.env.FILL_COUNT ?? 20000)

const layer = LayerNode.compile(
  LayerNode.group([
    Config.node,
    CrossSpawnSpawner.node,
    Agent.node,
    BackgroundJob.node,
    Session.node,
    SessionProjector.node,
    SessionRunState.node,
    SessionStatus.node,
    Database.node,
  ]),
  [[InstanceStore.bootstrapNode, InstanceBootstrap.node]],
)

const fillLarge = (sessionID: string) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const { MessageTable, PartTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
    const now = Date.now()
    const users = COUNT / 2
    for (let i = 0; i < users; i++) {
      const uid = MessageID.make(`msg_bulk_u${i}`)
      const aid = MessageID.make(`msg_bulk_a${i}`)
      const t = now - (users - i) * 10
      yield* db
        .insert(MessageTable)
        .values({
          id: uid,
          session_id: sessionID,
          time_created: t,
          time_updated: t,
          data: {
            role: "user",
            agent: "build",
            model: { providerID: "test", modelID: "test" },
            time: { created: t },
          } as never,
        } as never)
        .run()
      yield* db
        .insert(PartTable)
        .values({
          id: PartID.make(`prt_bulk_u${i}`),
          message_id: uid,
          session_id: sessionID,
          time_created: t,
          data: { type: "text", text: `u${i} ${"x".repeat(50)}` } as never,
        } as never)
        .run()
      yield* db
        .insert(MessageTable)
        .values({
          id: aid,
          session_id: sessionID,
          time_created: t + 1,
          data: {
            role: "assistant",
            parentID: uid,
            mode: "build",
            agent: "build",
            path: { cwd: "/tmp", root: "/tmp" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test",
            providerID: "test",
            time: { created: t + 1 },
            finish: "stop",
          } as never,
        } as never)
        .run()
      yield* db
        .insert(PartTable)
        .values({
          id: PartID.make(`prt_bulk_a${i}`),
          message_id: aid,
          session_id: sessionID,
          time_created: t + 1,
          data: { type: "text", text: `a${i} ${"y".repeat(50)}` } as never,
        } as never)
        .run()
    }
  }).pipe(Effect.orDie)

const program = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const session = yield* sessions.create({ title: "rearm-large" })

  const t0 = performance.now()
  yield* fillLarge(session.id)
  const fillMs = performance.now() - t0
  console.log(`[fill] ${COUNT} messages in ${fillMs.toFixed(0)}ms`)

  // Old predicate cost: full load through filterCompactedEffect.
  const t1 = performance.now()
  const msgs = yield* MessageV2.filterCompactedEffect(session.id)
  const fullLoadMs = performance.now() - t1
  console.log(`[old predicate] filterCompactedEffect full load: ${fullLoadMs.toFixed(0)}ms (${msgs.length} msgs)`)

  // New predicate cost: the single-row query, as hasUnconsumedTurn runs it.
  const t2 = performance.now()
  const role = yield* MessageV2.latestRole(session.id)
  const latestRoleMs = performance.now() - t2
  console.log(`[new predicate] latestRole: ${latestRoleMs.toFixed(3)}ms (role=${role})`)

  if (latestRoleMs > 500) {
    console.error(`FAIL: latestRole took ${latestRoleMs.toFixed(0)}ms, bound is 500ms`)
    process.exitCode = 1
  } else {
    console.log(`PASS: latestRole ${latestRoleMs.toFixed(2)}ms < 500ms bound (full load was ${fullLoadMs.toFixed(0)}ms)`)
  }
})

const run = withTmpdirInstance({})(program as never).pipe(Effect.provide(layer), Effect.scoped)
Effect.runPromise(run as never).then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error("FAILED", e)
    process.exit(1)
  },
)
