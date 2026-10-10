import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { AgentStatusProjection } from "@/agent-management/status"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const layer = LayerNode.compile(
  LayerNode.group([
    EventV2Bridge.node,
    Config.node,
    CrossSpawnSpawner.node,
    Session.node,
    SessionProjector.node,
    SessionStatus.node,
    Database.node,
    AgentStatusProjection.node,
  ]),
)

const it = testEffect(layer)

describe("AgentStatusProjection", () => {
  it.instance("an unknown session projects to idle", () =>
    Effect.gen(function* () {
      const projection = yield* AgentStatusProjection.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "root" })

      expect(yield* projection.of(session.id)).toBe("idle")
    }),
  )

  it.instance("busy projects to running", () =>
    Effect.gen(function* () {
      const projection = yield* AgentStatusProjection.Service
      const status = yield* SessionStatus.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "root" })

      yield* status.set(session.id, { type: "busy" })
      expect(yield* projection.of(session.id)).toBe("running")
    }),
  )

  it.instance("retry projects to running, because the execution has not finished", () =>
    Effect.gen(function* () {
      const projection = yield* AgentStatusProjection.Service
      const status = yield* SessionStatus.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "root" })

      yield* status.set(session.id, { type: "retry", attempt: 1, message: "rate limited", next: Date.now() + 1000 })
      expect(yield* projection.of(session.id)).toBe("running")
    }),
  )

  it.instance("returning to idle projects to idle", () =>
    Effect.gen(function* () {
      const projection = yield* AgentStatusProjection.Service
      const status = yield* SessionStatus.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "root" })

      yield* status.set(session.id, { type: "busy" })
      yield* status.set(session.id, { type: "idle" })
      expect(yield* projection.of(session.id)).toBe("idle")
    }),
  )
})
