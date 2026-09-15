import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Effect } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Truncate } from "@/tool/truncate"
import { AgentLifecycle } from "@/agent-management/lifecycle"
import { AgentInbox } from "@/agent-management/inbox"
import { AgentStatusProjection } from "@/agent-management/status"
import { AgentTree } from "@/agent-management/tree"
import { AgentManagement } from "@/agent-management/schema"
import { AgentTool, AgentListTool, AgentSendTool, AgentStopTool, visibleAgentTools } from "@/tool/agent"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
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
    Agent.node,
    BackgroundJob.node,
    Session.node,
    SessionProjector.node,
    SessionRunState.node,
    SessionStatus.node,
    Truncate.node,
    Database.node,
    Ripgrep.node,
    AgentTree.node,
    AgentInbox.node,
    AgentStatusProjection.node,
    AgentLifecycle.node,
  ]),
  [[InstanceStore.bootstrapNode, InstanceBootstrap.node]],
)

const it = testEffect(layer)
const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

function stubOps() {
  const seen: SessionPrompt.PromptInput[] = []
  const ops: AgentManagement.AgentPromptOps = {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        seen.push(input)
        return {
          info: {
            role: "assistant",
            id: "msg",
            sessionID: input.sessionID,
            finish: "stop",
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [{ type: "text", text: "done" }],
        } as unknown as SessionV1.WithParts
      }),
    deliverAsync: (input) => Effect.forkDetach(ops.prompt(input)).pipe(Effect.asVoid),
  }
  return { seen, ops }
}

const seed = Effect.fn("ToolsTest.seed")(function* () {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "root" })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  } as SessionV1.Assistant)
  return { chat, assistant }
})

const context = (sessionID: string, messageID: string, ops: AgentManagement.AgentPromptOps, asked?: string[]) => ({
  sessionID: sessionID as never,
  messageID: messageID as never,
  agent: "build",
  abort: new AbortController().signal,
  extra: { promptOps: ops },
  messages: [],
  metadata: () => Effect.void,
  ask: (req: { permission: string }) => Effect.sync(() => void asked?.push(req.permission)),
})

describe("agent tool", () => {
  it.instance("evaluates the agent permission before creating anything", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* AgentTool).init()
      const { ops } = stubOps()
      const asked: string[] = []

      yield* def.execute(
        { description: "look", prompt: "find it", subagent_type: "explore", cwd: "/tmp" },
        context(chat.id, assistant.id, ops, asked) as never,
      )

      expect(asked).toEqual(["agent"])
    }))

  it.instance("does not claim a live status it cannot know yet", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* AgentTool).init()
      const { ops } = stubOps()

      const result = yield* def.execute(
        { description: "look", prompt: "find it", subagent_type: "explore", cwd: "/tmp" },
        context(chat.id, assistant.id, ops) as never,
      )

      expect(result.output).toContain("session_id:")
      expect(result.output).toContain("agent_list")
      expect(result.output).not.toContain("status: running")
    }))

  it.instance("records the child's resolved model, not the parent's candidate", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* AgentTool).init()
      const { ops } = stubOps()

      const result = yield* def.execute(
        { description: "look", prompt: "find it", subagent_type: "explore", cwd: "/tmp" },
        context(chat.id, assistant.id, ops) as never,
      )

      expect(result.metadata.parentSessionId).toBe(chat.id)
      expect(result.metadata.model).toBeDefined()
    }))
})

describe("agent_send tool", () => {
  it.instance("says plainly that it is one-way and unconfirmed", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const def = yield* (yield* AgentSendTool).init()
      const { ops } = stubOps()

      const result = yield* def.execute(
        { target: child.id, message: "carry on" },
        context(chat.id, assistant.id, ops) as never,
      )

      expect(result.output).toContain("Accepted")
      expect(result.output).toContain("one-way")
      expect(result.output).toContain("not guaranteed")
    }))

  it.instance("lists every candidate when a name is ambiguous and sends nothing", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const a = yield* sessions.create({
        parentID: chat.id,
        title: "a",
        metadata: { [AgentManagement.METADATA_AGENT_NAME]: "twin" },
      })
      const b = yield* sessions.create({
        parentID: chat.id,
        title: "b",
        metadata: { [AgentManagement.METADATA_AGENT_NAME]: "twin" },
      })
      const def = yield* (yield* AgentSendTool).init()
      const { ops, seen } = stubOps()

      const result = yield* def.execute(
        { target: "twin", message: "carry on" },
        context(chat.id, assistant.id, ops) as never,
      )

      expect(result.output).toContain(a.id)
      expect(result.output).toContain(b.id)
      expect(result.output).toContain("session_id")
      expect(seen).toHaveLength(0)
    }))
})

describe("agent_stop tool", () => {
  it.instance("does not claim the target had been running", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const def = yield* (yield* AgentStopTool).init()
      const { ops } = stubOps()

      const result = yield* def.execute({ target: child.id }, context(chat.id, assistant.id, ops) as never)

      expect(result.output).toContain(child.id)
      expect(result.output).toContain("does not mean each was running")
      expect(result.output).toContain("agent_send")
    }))

  it.instance("refuses a target that is not a direct child", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const a = yield* sessions.create({ parentID: chat.id, title: "a" })
      const b = yield* sessions.create({ parentID: a.id, title: "b" })
      const def = yield* (yield* AgentStopTool).init()
      const { ops } = stubOps()

      const result = yield* def.execute({ target: b.id }, context(chat.id, assistant.id, ops) as never)
      expect(result.output).toContain("only stop")
    }))
})

describe("agent_list tool", () => {
  it.instance("shows both the session id and the name", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({
        parentID: chat.id,
        title: "child",
        agent: "explore",
        metadata: { [AgentManagement.METADATA_AGENT_NAME]: "reviewer" },
      })
      const def = yield* (yield* AgentListTool).init()
      const { ops } = stubOps()

      const result = yield* def.execute({}, context(chat.id, assistant.id, ops) as never)

      expect(result.output).toContain(child.id)
      expect(result.output).toContain("reviewer")
      expect(result.output).toContain("explore")
      expect(result.output).toContain("idle")
    }))

  it.instance("never returns an empty table, which would read as an error", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* AgentListTool).init()
      const { ops } = stubOps()

      const result = yield* def.execute({}, context(chat.id, assistant.id, ops) as never)
      expect(result.output).toContain(chat.id)
      expect(result.metadata.count).toBe(1)
    }))
})

describe("tool visibility", () => {
  it.instance("offers all four below the limit and withdraws two at it", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      let current = yield* sessions.create({ title: "root" })
      expect(yield* visibleAgentTools(current.id)).toHaveLength(4)

      for (let depth = 0; depth < 3; depth += 1) {
        current = yield* sessions.create({ parentID: current.id, title: `d${depth}` })
      }

      // At the limit an Agent can never spawn, so it can never have a child to
      // stop; offering either would only cost the model a turn to discover.
      const atLimit = yield* visibleAgentTools(current.id)
      expect(atLimit.toSorted()).toEqual(["agent_list", "agent_send"])
    }))
})
