import { describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Deferred, Effect, Exit, Layer } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GlobalBus } from "@/bus/global"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionNs.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const awaitDeferred = <T>(deferred: Deferred.Deferred<T>, message: string) =>
  Effect.race(
    Deferred.await(deferred),
    Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error(message)))),
  )

const remove = (id: SessionID) => SessionNs.use.remove(id)

describe("session.created event", () => {
  it.instance("should emit session.created event when session is created", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const received = yield* Deferred.make<SessionNs.Info>()

      const unsub = yield* events.listen((event) => {
        if (event.type === SessionNs.Event.Created.type)
          Deferred.doneUnsafe(
            received,
            Effect.succeed((event.data as typeof SessionNs.Event.Created.data.Type).info as SessionNs.Info),
          )
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const info = yield* session.create({})
      const receivedInfo = yield* awaitDeferred(received, "timed out waiting for session.created")

      expect(receivedInfo.id).toBe(info.id)
      expect(receivedInfo.projectID).toBe(info.projectID)
      expect(receivedInfo.directory).toBe(info.directory)
      expect(receivedInfo.path).toBe(info.path)
      expect(receivedInfo.title).toBe(info.title)

      yield* session.remove(info.id)
    }),
  )

  it.instance("session.created event should be emitted before session.updated", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* EventV2Bridge.Service
      const events: string[] = []
      const received = yield* Deferred.make<string[]>()
      const push = (event: string) => {
        events.push(event)
        if (events.includes("created") && events.includes("updated")) {
          Deferred.doneUnsafe(received, Effect.succeed(events))
        }
      }

      const unsubscribe = yield* source.listen((event) => {
        if (event.type === SessionNs.Event.Created.type) push("created")
        if (event.type === SessionNs.Event.Updated.type) push("updated")
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      const info = yield* session.create({})
      yield* session.setTitle({ sessionID: info.id, title: "updated" })
      const receivedEvents = yield* awaitDeferred(received, "timed out waiting for session created/updated events")

      expect(receivedEvents).toContain("created")
      expect(receivedEvents).toContain("updated")
      expect(receivedEvents.indexOf("created")).toBeLessThan(receivedEvents.indexOf("updated"))

      yield* session.remove(info.id)
    }),
  )

  it.instance("emits legacy global sync payload", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const received = yield* Deferred.make<{ syncEvent: EventV2.SerializedEvent }>()
      const listener = (event: { payload: { type?: string; syncEvent?: EventV2.SerializedEvent } }) => {
        if (event.payload.type === "sync" && event.payload.syncEvent)
          Deferred.doneUnsafe(received, Effect.succeed({ syncEvent: event.payload.syncEvent }))
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      const info = yield* session.create({})
      const event = yield* awaitDeferred(received, "timed out waiting for legacy global sync event")

      expect(event.syncEvent).toMatchObject({
        type: EventV2.versionedType(SessionNs.Event.Created.type, 1),
        seq: 0,
        aggregateID: info.id,
        data: { sessionID: info.id },
      })

      yield* session.remove(info.id)
    }),
  )
})

describe("step-finish token propagation via event", () => {
  it.instance(
    "non-zero tokens propagate through PartUpdated event",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const events = yield* EventV2Bridge.Service
        const info = yield* session.create({})

        const messageID = MessageID.ascending()
        yield* session.updateMessage({
          id: messageID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as SessionV1.Info)

        // Event subscribers receive readonly Schema.Type payloads; `SessionV1.Part`
        // is the mutable domain type. Cast bridges the two — safe because the
        // test only reads the value afterwards.
        const received = yield* Deferred.make<SessionV1.Part>()
        const unsub = yield* events.listen((event) => {
          if (event.type === MessageV2.Event.PartUpdated.type)
            Deferred.doneUnsafe(
              received,
              Effect.succeed((event.data as typeof MessageV2.Event.PartUpdated.data.Type).part as SessionV1.Part),
            )
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsub)

        const tokens = {
          total: 1500,
          input: 500,
          output: 800,
          reasoning: 200,
          cache: { read: 100, write: 50 },
        }

        const partInput = {
          id: PartID.ascending(),
          messageID,
          sessionID: info.id,
          type: "step-finish" as const,
          reason: "stop",
          cost: 0.005,
          tokens,
        }

        yield* session.updatePart(partInput)
        const receivedPart = yield* awaitDeferred(received, "timed out waiting for message.part.updated")

        expect(receivedPart.type).toBe("step-finish")
        const finish = receivedPart as SessionV1.StepFinishPart
        expect(finish.tokens.input).toBe(500)
        expect(finish.tokens.output).toBe(800)
        expect(finish.tokens.reasoning).toBe(200)
        expect(finish.tokens.total).toBe(1500)
        expect(finish.tokens.cache.read).toBe(100)
        expect(finish.tokens.cache.write).toBe(50)
        expect(finish.cost).toBe(0.005)
        expect(receivedPart).not.toBe(partInput)

        yield* session.remove(info.id)
      }),
    { timeout: 30000 },
  )
})

describe("Session", () => {
  it.live("remove works without an instance", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const dir = yield* tmpdirScoped({ git: true })
      const info = yield* provideInstance(dir)(session.create({ title: "remove-without-instance" }))

      const removeExit = yield* remove(info.id).pipe(Effect.exit)
      expect(Exit.isSuccess(removeExit)).toBe(true)

      const getExit = yield* session.get(info.id).pipe(Effect.exit)
      expect(Exit.isFailure(getExit)).toBe(true)
    }),
  )

  it.instance("persists metadata and copies it on fork by default", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const meta = { source: "sdk", trace: { id: "abc" } }
      const created = yield* Effect.acquireRelease(session.create({ title: "with-meta", metadata: meta }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)
      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      expect(saved.metadata).toEqual(meta)
      expect(fork.metadata).toEqual(meta)
      expect(fork.metadata).not.toBe(meta)
    }),
  )

  it.instance("forks the chronological prefix across mixed message ID ordering", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({}), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const ids = ["msg_z9-before", "msg_z1-before-wrap", "msg_a0-after-wrap", "msg_a1-after"]
      for (const [index, id] of ids.entries()) {
        yield* session.updateMessage({
          id: MessageID.make(id),
          sessionID: created.id,
          role: "user",
          time: { created: index + 1 },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
        } as SessionV1.User)
      }

      const beforeWrap = yield* Effect.acquireRelease(
        session.fork({ sessionID: created.id, messageID: MessageID.make(ids[1]!) }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )
      const afterWrap = yield* Effect.acquireRelease(
        session.fork({ sessionID: created.id, messageID: MessageID.make(ids[2]!) }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )

      expect((yield* session.messages({ sessionID: beforeWrap.id })).map((msg) => msg.info.time.created)).toEqual([1])
      expect((yield* session.messages({ sessionID: afterWrap.id })).map((msg) => msg.info.time.created)).toEqual([1, 2])
    }),
  )

  it.instance("omits metadata when not provided", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "empty-meta" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)

      expect(created.metadata).toBeUndefined()
      expect(saved.metadata).toBeUndefined()
    }),
  )
})

// Subplan agentmgmt-2-run-state §5.2.0: a patch is read-merge-publish over the
// whole row, so patches of one session have to run one at a time or each
// writes the other's stale fields back (I11).
describe("Session.patch serializes writes to one session", () => {
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

  // T9: random concurrent patches. Every `session.updated` is published inside
  // the lock, in lock order, so the sequence of published rows is the serial
  // order the lock chose. A lost update is a field going back to a value it
  // already had: the row that lost it was merged from a stale read. Every op
  // writes a value of its own, so the check is that no observed field ever
  // takes a value seen before, that every written value shows up in some row,
  // and that the final row is the last published one.
  it.instance("concurrent patches of one session never lose a field (T9)", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* EventV2Bridge.Service
      for (let n = 0; n < 6; n++) {
        const next = rng(9100 + n)
        const info = yield* session.create({ title: "racy" })
        const rows: SessionNs.Info[] = []
        const unsubscribe = yield* source.listen((event) => {
          if (event.type !== SessionNs.Event.Updated.type) return Effect.void
          const data = event.data as { sessionID: string; info: SessionNs.Info }
          if (data.sessionID === info.id) rows.push(data.info)
          return Effect.void
        })
        const written: Record<string, string[]> = { title: [], note: [], agent: [], model: [] }
        const ops = Array.from({ length: 3 + Math.floor(next() * 10) }, (_, i) => {
          const roll = next()
          if (roll < 0.3) {
            written.title.push(`title ${i}`)
            return session.setTitle({ sessionID: info.id, title: `title ${i}` })
          }
          if (roll < 0.6) {
            written.note.push(`meta ${i}`)
            return session.setMetadata({ sessionID: info.id, metadata: { note: `meta ${i}` } })
          }
          if (roll < 0.8) return session.touch(info.id)
          written.agent.push(`agent ${i}`)
          written.model.push(`m${i}`)
          return session.setAgentModel({
            sessionID: info.id,
            agent: `agent ${i}`,
            model: { providerID: ProviderV2.ID.make("p"), id: ModelV2.ID.make(`m${i}`) },
            time: Date.now(),
          })
        })
        yield* Effect.all(ops, { concurrency: "unbounded", discard: true })
        yield* unsubscribe

        expect(rows, `seed ${9100 + n}`).toHaveLength(ops.length)
        const fields = {
          title: (row: SessionNs.Info) => row.title,
          note: (row: SessionNs.Info) => String(row.metadata?.note ?? ""),
          agent: (row: SessionNs.Info) => row.agent ?? "",
          model: (row: SessionNs.Info) => row.model?.id ?? "",
        }
        for (const [field, read] of Object.entries(fields)) {
          const seen = new Set<string>()
          let current = read(info)
          seen.add(current)
          for (const row of rows) {
            const value = read(row)
            if (value === current) continue
            expect(seen.has(value), `seed ${9100 + n}: ${field} went back to "${value}"`).toBe(false)
            seen.add(value)
            current = value
          }
          for (const value of written[field]!)
            expect(seen.has(value), `seed ${9100 + n}: ${field} "${value}" never landed`).toBe(true)
        }
        expect(yield* session.get(info.id)).toEqual(rows.at(-1)!)
        yield* session.remove(info.id)
      }
    }),
  )

  // The guard (H6c): publish awaits its listeners, so a listener that patches
  // the session it was just told about waits on the permit the outer patch
  // holds. The bounded take turns that into a defect naming the session,
  // instead of a wedge; the outer patch's row is already projected by then.
  it.instance("a listener patching the session it was told about dies after the timeout instead of hanging", () =>
    Effect.gen(function* () {
      const saved = process.env["OPENCODE_SESSION_PATCH_LOCK_MS"]
      process.env["OPENCODE_SESSION_PATCH_LOCK_MS"] = "300"
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (saved === undefined) delete process.env["OPENCODE_SESSION_PATCH_LOCK_MS"]
          else process.env["OPENCODE_SESSION_PATCH_LOCK_MS"] = saved
        }),
      )
      const session = yield* SessionNs.Service
      const source = yield* EventV2Bridge.Service
      const info = yield* session.create({ title: "reentrant" })
      const nested = yield* Deferred.make<Exit.Exit<void>>()
      let fired = false
      const unsubscribe = yield* source.listen((event) => {
        if (fired || event.type !== SessionNs.Event.Updated.type) return Effect.void
        if ((event.data as { sessionID: string }).sessionID !== info.id) return Effect.void
        fired = true
        return session.setTitle({ sessionID: info.id, title: "from the listener" }).pipe(
          Effect.exit,
          Effect.flatMap((exit) => Deferred.succeed(nested, exit)),
          Effect.asVoid,
        )
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      const started = Date.now()
      yield* session.setTitle({ sessionID: info.id, title: "outer" }).pipe(Effect.exit)
      const inner = yield* awaitWithTimeout(Deferred.await(nested), "the nested patch never settled", "5 seconds")

      expect(Exit.isFailure(inner)).toBe(true)
      if (Exit.isFailure(inner)) expect(Cause.pretty(inner.cause)).toContain(`re-entered: ${info.id}`)
      expect(Date.now() - started).toBeLessThan(5_000)
      expect((yield* session.get(info.id)).title).toBe("outer")
      yield* session.remove(info.id)
    }),
  )

  // Expectations §8: the lock is held for one row read, one transaction and
  // the synchronous listeners.
  it.instance("one patch holds the lock for well under 50 ms", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* session.create({ title: "quick" })
      // Warm the path once; the first call pays for lazy initialisation.
      yield* session.touch(info.id)
      const started = performance.now()
      yield* session.setTitle({ sessionID: info.id, title: "timed" })
      expect(performance.now() - started).toBeLessThan(50)
      yield* session.remove(info.id)
    }),
  )
})
