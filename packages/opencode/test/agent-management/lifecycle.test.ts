import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Deferred, Effect } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Truncate } from "@/tool/truncate"
import { AgentLifecycle } from "@/agent-management/lifecycle"
import { AgentManagement } from "@/agent-management/schema"
import type { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { disposeAllInstances } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const layer = LayerNode.compile(
  LayerNode.group([
    EventV2Bridge.node,
    Config.node,
    CrossSpawnSpawner.node,
    Agent.node,
    BackgroundJob.node,
    Session.node,
    SessionProjector.node,
    SessionRunState.node,
    SessionStatus.node,
    Truncate.node,
    Database.node,
    Ripgrep.node,
    AgentLifecycle.node,
  ]),
  [[InstanceStore.bootstrapNode, InstanceBootstrap.node]],
)

const it = testEffect(layer)

const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

function stubOps(opts?: { block?: Deferred.Deferred<void>; text?: string }) {
  const seen: SessionPrompt.PromptInput[] = []
  const ops: AgentManagement.AgentPromptOps = {
    cancel: () => Effect.void,
    resolvePromptParts: (template) =>
      Effect.succeed([
        { type: "text" as const, text: template },
        { type: "file" as const, mime: "text/plain", url: "file:///tmp/attached.txt", filename: "attached.txt" },
      ] as SessionPrompt.PromptInput["parts"]),
    prompt: (input) =>
      Effect.gen(function* () {
        seen.push(input)
        if (opts?.block) yield* Deferred.await(opts.block)
        return {
          info: {
            role: "assistant",
            id: "msg",
            sessionID: input.sessionID,
            finish: "stop",
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [{ type: "text", text: opts?.text ?? "done" }],
        } as unknown as SessionV1.WithParts
      }),
  }
  return { seen, ops }
}

const baseCreate = (caller: SessionID, ops: AgentManagement.AgentPromptOps, overrides = {}) => ({
  caller,
  subagent_type: "explore",
  description: "look around",
  prompt: "find the thing",
  cwd: "/tmp",
  model: ref,
  variant: "xhigh" as string | undefined,
  ops,
  ...overrides,
})

describe("AgentLifecycle.create", () => {
  it.instance("creates a child session and returns without a live status", () =>
    Effect.gen(function* () {
      const lifecycle = yield* AgentLifecycle.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root" })
      const { ops } = stubOps()

      const result = yield* lifecycle.create(baseCreate(root.id, ops))

      expect(result.session_id).toBeDefined()
      expect(result.agent_type).toBe("explore")
      expect("status" in result).toBe(false)
      const child = yield* sessions.get(result.session_id)
      expect(child.parentID).toBe(root.id)
    }))

  it.instance("persists the resolved identity at creation, not on the first prompt", () =>
    Effect.gen(function* () {
      const lifecycle = yield* AgentLifecycle.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root" })
      const gate = yield* Deferred.make<void>()
      const { ops } = stubOps({ block: gate })

      const result = yield* lifecycle.create(baseCreate(root.id, ops))

      // Still blocked inside the delegation, so nothing has been written by the
      // prompt path yet.
      const child = yield* sessions.get(result.session_id)
      expect(child.agent).toBe("explore")
      expect(child.model?.id).toBe(ref.modelID)
      expect(child.model?.providerID).toBe(ref.providerID)
      yield* Deferred.succeed(gate, undefined)
    }))

  it.instance("keeps the prompt as parts so attachments survive", () =>
    Effect.gen(function* () {
      const lifecycle = yield* AgentLifecycle.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root" })
      const { ops, seen } = stubOps()

      yield* lifecycle.create(baseCreate(root.id, ops))
      yield* awaitWithTimeout(
        Effect.gen(function* () {
          while (seen.length === 0) yield* Effect.sleep("10 millis")
        }),
        "delegation never ran",
      )

      const kinds = seen[0].parts.map((part) => part.type)
      expect(kinds).toContain("file")
      expect((seen[0].parts[0] as { text: string }).text).toContain("Your working directory")
    }))

  it.instance("refuses a duplicate instance name without creating anything", () =>
    Effect.gen(function* () {
      const lifecycle = yield* AgentLifecycle.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root" })
      const { ops } = stubOps()

      yield* lifecycle.create(baseCreate(root.id, ops, { name: "reviewer" }))
      const before = (yield* sessions.children(root.id)).length

      const error = yield* lifecycle.create(baseCreate(root.id, ops, { name: "reviewer" })).pipe(Effect.flip)

      expect(error._tag).toBe("AgentNameConflict")
      expect((yield* sessions.children(root.id)).length).toBe(before)
    }))

  it.instance("refuses a name that could be mistaken for a session id", () =>
    Effect.gen(function* () {
      const lifecycle = yield* AgentLifecycle.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root" })
      const { ops } = stubOps()

      const error = yield* lifecycle.create(baseCreate(root.id, ops, { name: "session-one" })).pipe(Effect.flip)
      expect(error._tag).toBe("AgentNameConflict")
      expect((error as AgentManagement.AgentNameConflict).reason).toBe("reserved_prefix")
    }))

  it.instance("rejects an unknown agent type without creating a session", () =>
    Effect.gen(function* () {
      const lifecycle = yield* AgentLifecycle.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root" })
      const { ops } = stubOps()

      const error = yield* lifecycle
        .create(baseCreate(root.id, ops, { subagent_type: "nope" }))
        .pipe(Effect.flip)

      expect(error._tag).toBe("AgentTypeNotFound")
      expect((yield* sessions.children(root.id)).length).toBe(0)
    }))

  it.instance(
    "stops spawning at the depth limit",
    () =>
      Effect.gen(function* () {
        const lifecycle = yield* AgentLifecycle.Service
        const sessions = yield* Session.Service
        const { ops } = stubOps()

        let current = yield* sessions.create({ title: "root" })
        for (let depth = 0; depth < 3; depth += 1) {
          const result = yield* lifecycle.create(baseCreate(current.id, ops))
          current = yield* sessions.get(result.session_id)
        }

        const error = yield* lifecycle.create(baseCreate(current.id, ops)).pipe(Effect.flip)
        expect(error._tag).toBe("DepthLimitReached")
        expect((error as AgentManagement.DepthLimitReached).limit).toBe(3)
      }),
    { config: { subagent_depth: 3 } },
  )
})

describe("AgentLifecycle.stop", () => {
  it.instance("refuses a target that is not a direct child", () =>
    Effect.gen(function* () {
      const lifecycle = yield* AgentLifecycle.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root" })
      const a = yield* sessions.create({ parentID: root.id, title: "a" })
      const b = yield* sessions.create({ parentID: a.id, title: "b" })
      const { ops } = stubOps()

      const error = yield* lifecycle.stop({ caller: root.id, target: b.id, ops }).pipe(Effect.flip)
      expect(error._tag).toBe("NotAChild")
    }))

  it.instance("cancels the whole subtree and reports every member", () =>
    Effect.gen(function* () {
      const lifecycle = yield* AgentLifecycle.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root" })
      const a = yield* sessions.create({ parentID: root.id, title: "a" })
      const b = yield* sessions.create({ parentID: a.id, title: "b" })
      const c = yield* sessions.create({ parentID: b.id, title: "c" })
      const { ops } = stubOps()

      const outcome = yield* lifecycle.stop({ caller: root.id, target: a.id, ops })

      expect(outcome.stopped.toSorted()).toEqual([a.id, b.id, c.id].toSorted())
      expect(outcome.failed).toEqual([])
    }))

  it.instance("notifies only the caller, never a member of the stop set", () =>
    Effect.gen(function* () {
      const lifecycle = yield* AgentLifecycle.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root" })
      const a = yield* sessions.create({ parentID: root.id, title: "a" })
      const b = yield* sessions.create({ parentID: a.id, title: "b" })
      const { ops, seen } = stubOps()

      yield* lifecycle.stop({ caller: root.id, target: a.id, ops })
      yield* awaitWithTimeout(
        Effect.gen(function* () {
          while (seen.length === 0) yield* Effect.sleep("10 millis")
        }),
        "no notice delivered",
      )
      yield* Effect.sleep("100 millis")

      expect(seen).toHaveLength(1)
      expect(seen[0].sessionID).toBe(root.id)
      // Nothing was sent to a, which is exactly what could wake it back up.
      expect(seen.some((input) => input.sessionID === a.id || input.sessionID === b.id)).toBe(false)
    }))

  it.instance("is idempotent: stopping an idle subtree again is harmless", () =>
    Effect.gen(function* () {
      const lifecycle = yield* AgentLifecycle.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root" })
      const a = yield* sessions.create({ parentID: root.id, title: "a" })
      const { ops } = stubOps()

      const first = yield* lifecycle.stop({ caller: root.id, target: a.id, ops })
      const second = yield* lifecycle.stop({ caller: root.id, target: a.id, ops })

      expect(first.stopped).toEqual([a.id])
      expect(second.stopped).toEqual([a.id])
      expect(second.failed).toEqual([])
    }))

  it.instance("leaves the session and its history intact so it can be resumed", () =>
    Effect.gen(function* () {
      const lifecycle = yield* AgentLifecycle.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root" })
      const a = yield* sessions.create({ parentID: root.id, title: "a" })
      const { ops } = stubOps()

      yield* lifecycle.stop({ caller: root.id, target: a.id, ops })

      const still = yield* sessions.get(a.id)
      expect(still.id).toBe(a.id)
      expect(still.title).toBe("a")
    }))
})
