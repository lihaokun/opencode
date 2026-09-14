import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { AgentTree } from "@/agent-management/tree"
import { AgentManagement } from "@/agent-management/schema"
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
    Database.node,
    AgentTree.node,
  ]),
)

const it = testEffect(layer)

const spawn = Effect.fn("TreeTest.spawn")(function* (input: { parentID?: string; title: string; name?: string }) {
  const sessions = yield* Session.Service
  return yield* sessions.create({
    parentID: input.parentID as never,
    title: input.title,
    metadata: input.name ? { [AgentManagement.METADATA_AGENT_NAME]: input.name } : undefined,
  })
})

describe("AgentTree", () => {
  it.instance("neighborhood of a root session contains only itself", () =>
    Effect.gen(function* () {
      const tree = yield* AgentTree.Service
      const root = yield* spawn({ title: "root" })

      const result = yield* tree.neighborhood(root.id)

      expect(result.members).toHaveLength(1)
      expect(result.members[0].relation).toBe("self")
      expect(result.members[0].depth).toBe(0)
      expect(result.members[0].parent_id).toBeUndefined()
    }))

  it.instance("neighborhood covers parent, children and siblings but never grandchildren", () =>
    Effect.gen(function* () {
      const tree = yield* AgentTree.Service
      const root = yield* spawn({ title: "root" })
      const a = yield* spawn({ parentID: root.id, title: "a" })
      const b = yield* spawn({ parentID: root.id, title: "b" })
      const grandchild = yield* spawn({ parentID: a.id, title: "grandchild" })
      const greatGrandchild = yield* spawn({ parentID: grandchild.id, title: "ggc" })

      const result = yield* tree.neighborhood(a.id)
      const ids = result.members.map((m) => m.session_id)

      expect(ids).toContain(a.id)
      expect(ids).toContain(root.id)
      expect(ids).toContain(b.id)
      expect(ids).toContain(grandchild.id)
      expect(ids).not.toContain(greatGrandchild.id)

      const byId = new Map(result.members.map((m) => [m.session_id, m]))
      expect(byId.get(a.id)!.relation).toBe("self")
      expect(byId.get(root.id)!.relation).toBe("parent")
      expect(byId.get(b.id)!.relation).toBe("sibling")
      expect(byId.get(grandchild.id)!.relation).toBe("child")
    }))

  it.instance("assigns depth relative to the tree root", () =>
    Effect.gen(function* () {
      const tree = yield* AgentTree.Service
      const root = yield* spawn({ title: "root" })
      const a = yield* spawn({ parentID: root.id, title: "a" })
      const grandchild = yield* spawn({ parentID: a.id, title: "grandchild" })

      expect(yield* tree.callerDepth(root.id)).toBe(0)
      expect(yield* tree.callerDepth(a.id)).toBe(1)
      expect(yield* tree.callerDepth(grandchild.id)).toBe(2)

      const members = (yield* tree.neighborhood(a.id)).members
      const byId = new Map(members.map((m) => [m.session_id, m]))
      expect(byId.get(root.id)!.depth).toBe(0)
      expect(byId.get(a.id)!.depth).toBe(1)
      expect(byId.get(grandchild.id)!.depth).toBe(2)
    }))

  it.instance("orders members by relation then creation then id so the roster is stable", () =>
    Effect.gen(function* () {
      const tree = yield* AgentTree.Service
      const root = yield* spawn({ title: "root" })
      const a = yield* spawn({ parentID: root.id, title: "a" })
      yield* spawn({ parentID: a.id, title: "c1" })
      yield* spawn({ parentID: a.id, title: "c2" })
      yield* spawn({ parentID: root.id, title: "sib" })

      const first = (yield* tree.neighborhood(a.id)).members.map((m) => m.session_id)
      const second = (yield* tree.neighborhood(a.id)).members.map((m) => m.session_id)

      expect(first).toEqual(second)
      const relations = (yield* tree.neighborhood(a.id)).members.map((m) => m.relation)
      expect(relations).toEqual(["self", "parent", "child", "child", "sibling"])
    }))

  it.instance("descendants returns the closure without the root of the subtree", () =>
    Effect.gen(function* () {
      const tree = yield* AgentTree.Service
      const root = yield* spawn({ title: "root" })
      const a = yield* spawn({ parentID: root.id, title: "a" })
      const b = yield* spawn({ parentID: a.id, title: "b" })
      const c = yield* spawn({ parentID: b.id, title: "c" })

      const result = yield* tree.descendants(a.id, 1)
      const ids = result.map((m) => m.session_id)

      expect(ids).not.toContain(a.id)
      expect(ids).toContain(b.id)
      expect(ids).toContain(c.id)
      expect(result.find((m) => m.session_id === b.id)!.depth).toBe(2)
      expect(result.find((m) => m.session_id === c.id)!.depth).toBe(3)
    }))

  it.instance("isChild only accepts direct children", () =>
    Effect.gen(function* () {
      const tree = yield* AgentTree.Service
      const root = yield* spawn({ title: "root" })
      const a = yield* spawn({ parentID: root.id, title: "a" })
      const b = yield* spawn({ parentID: a.id, title: "b" })

      expect(yield* tree.isChild(root.id, a.id)).toBe(true)
      expect(yield* tree.isChild(root.id, b.id)).toBe(false)
      expect(yield* tree.isChild(a.id, b.id)).toBe(true)
    }))

  it.instance("resolveTarget passes a session id through without looking at names", () =>
    Effect.gen(function* () {
      const tree = yield* AgentTree.Service
      const root = yield* spawn({ title: "root" })
      const a = yield* spawn({ parentID: root.id, title: "a" })

      const resolved = yield* tree.resolveTarget({ caller: root.id, value: a.id, scope: "child" })
      expect(resolved).toBe(a.id)
    }))

  it.instance("resolveTarget finds a unique instance name", () =>
    Effect.gen(function* () {
      const tree = yield* AgentTree.Service
      const root = yield* spawn({ title: "root" })
      const a = yield* spawn({ parentID: root.id, title: "a", name: "reviewer" })

      expect(yield* tree.resolveTarget({ caller: root.id, value: "reviewer", scope: "child" })).toBe(a.id)
      expect(yield* tree.resolveTarget({ caller: root.id, value: "reviewer", scope: "neighbor" })).toBe(a.id)
    }))

  it.instance("resolveTarget reports every candidate when a name is ambiguous", () =>
    Effect.gen(function* () {
      const tree = yield* AgentTree.Service
      const root = yield* spawn({ title: "root" })
      const a = yield* spawn({ parentID: root.id, title: "a", name: "twin" })
      const b = yield* spawn({ parentID: root.id, title: "b", name: "twin" })

      const error = yield* tree
        .resolveTarget({ caller: root.id, value: "twin", scope: "child" })
        .pipe(Effect.flip)

      expect(error._tag).toBe("TargetNotResolved")
      expect((error as AgentManagement.TargetNotResolved).matches.toSorted()).toEqual([a.id, b.id].toSorted())
    }))

  it.instance("resolveTarget fails with no candidates when nothing matches", () =>
    Effect.gen(function* () {
      const tree = yield* AgentTree.Service
      const root = yield* spawn({ title: "root" })

      const error = yield* tree
        .resolveTarget({ caller: root.id, value: "nobody", scope: "child" })
        .pipe(Effect.flip)

      expect(error._tag).toBe("TargetNotResolved")
      expect((error as AgentManagement.TargetNotResolved).matches).toEqual([])
    }))

  it.instance("resolveTarget never resolves a caller to itself by name", () =>
    Effect.gen(function* () {
      const tree = yield* AgentTree.Service
      const root = yield* spawn({ title: "root", name: "boss" })

      const error = yield* tree
        .resolveTarget({ caller: root.id, value: "boss", scope: "neighbor" })
        .pipe(Effect.flip)

      expect(error._tag).toBe("TargetNotResolved")
      expect((error as AgentManagement.TargetNotResolved).matches).toEqual([])
    }))

  it.instance("resolveTarget matches instance names only, never agent types", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tree = yield* AgentTree.Service
      const root = yield* spawn({ title: "root" })
      yield* sessions.create({ parentID: root.id, title: "a", agent: "explore" })

      const error = yield* tree
        .resolveTarget({ caller: root.id, value: "explore", scope: "child" })
        .pipe(Effect.flip)

      expect(error._tag).toBe("TargetNotResolved")
      expect((error as AgentManagement.TargetNotResolved).matches).toEqual([])
    }))

  it.instance("resolveTarget with child scope does not see siblings", () =>
    Effect.gen(function* () {
      const tree = yield* AgentTree.Service
      const root = yield* spawn({ title: "root" })
      const a = yield* spawn({ parentID: root.id, title: "a" })
      yield* spawn({ parentID: root.id, title: "b", name: "peer" })

      const error = yield* tree.resolveTarget({ caller: a.id, value: "peer", scope: "child" }).pipe(Effect.flip)
      expect(error._tag).toBe("TargetNotResolved")

      const viaNeighbor = yield* tree.resolveTarget({ caller: a.id, value: "peer", scope: "neighbor" })
      expect(viaNeighbor).toBeDefined()
    }))
})
