import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
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
import { AgentStatusProjection } from "@/agent-management/status"
import { AgentTree } from "@/agent-management/tree"
import { AGENT_ROSTER_SENTINEL, applyAgentRoster } from "@/session/reminders"
import { MessageID, PartID, SessionID } from "@/session/schema"
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
    Database.node,
    AgentTree.node,
    AgentStatusProjection.node,
  ]),
  [[InstanceStore.bootstrapNode, InstanceBootstrap.node]],
)

const it = testEffect(layer)
const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

/** A user message with nothing after it — the shape at the start of a turn. */
const userMessage = Effect.fn("RosterTest.userMessage")(function* (sessionID: SessionID) {
  const sessions = yield* Session.Service
  const info = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  return { info, parts: [] } as SessionV1.WithParts
})

const assistantAfter = Effect.fn("RosterTest.assistantAfter")(function* (user: SessionV1.WithParts) {
  const sessions = yield* Session.Service
  const info = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.info.id,
    sessionID: user.info.sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() + 1 },
  })
  return { info, parts: [] } as SessionV1.WithParts
})

const rosterParts = (messages: SessionV1.WithParts[]) =>
  messages
    .flatMap((msg) => msg.parts)
    .filter((part) => part.type === "text" && part.text.startsWith(AGENT_ROSTER_SENTINEL))

describe("SessionReminders.applyAgentRoster", () => {
  it.instance("says nothing when the session has no subagents", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "root" })
      const messages = [yield* userMessage(session.id)]

      const out = yield* applyAgentRoster({ messages, session })
      expect(rosterParts(out)).toHaveLength(0)
    }),
  )

  it.instance("writes one at the start of a turn when there is a child", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "root" })
      const child = yield* sessions.create({ parentID: session.id, title: "child" })
      const messages = [yield* userMessage(session.id)]

      const out = yield* applyAgentRoster({ messages, session })
      const written = rosterParts(out)
      expect(written).toHaveLength(1)
      expect(written[0].type === "text" && written[0].text).toContain(child.id)
      // The heading says when it was true, because agent_list is the authority
      // and history keeps older ones.
      expect(written[0].type === "text" && written[0].text).toContain("at this point")
    }),
  )

  // The point of moving off per-step evaluation: a later step would append to a
  // user message already sent to the provider and invalidate everything after it.
  it.instance("says nothing again on a later step of the same turn", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "root" })
      yield* sessions.create({ parentID: session.id, title: "child" })

      const user = yield* userMessage(session.id)
      const first = yield* applyAgentRoster({ messages: [user], session })
      expect(rosterParts(first)).toHaveLength(1)

      // Step 1 of the same turn: the assistant message now exists.
      const second = yield* applyAgentRoster({ messages: [user, yield* assistantAfter(user)], session })
      expect(rosterParts(second)).toHaveLength(1)
    }),
  )

  it.instance("says nothing when the roster has not changed since the last one", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "root" })
      yield* sessions.create({ parentID: session.id, title: "child" })

      const first = yield* userMessage(session.id)
      const afterFirst = yield* applyAgentRoster({ messages: [first], session })
      expect(rosterParts(afterFirst)).toHaveLength(1)

      // A new turn, with the children in the same state as before.
      const second = yield* userMessage(session.id)
      const afterSecond = yield* applyAgentRoster({ messages: [...afterFirst, second], session })
      expect(rosterParts(afterSecond)).toHaveLength(1)
    }),
  )

  it.instance("writes another when a child appears", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "root" })
      yield* sessions.create({ parentID: session.id, title: "first child" })

      const first = yield* userMessage(session.id)
      const afterFirst = yield* applyAgentRoster({ messages: [first], session })

      yield* sessions.create({ parentID: session.id, title: "second child" })
      const second = yield* userMessage(session.id)
      const afterSecond = yield* applyAgentRoster({ messages: [...afterFirst, second], session })

      expect(rosterParts(afterSecond)).toHaveLength(2)
    }),
  )

  // A child can be woken through agent_send again and again, so the count of
  // these tracks observed state changes with no bound over a session's life.
  // That is the cost of the design, and it is recorded rather than denied.
  it.instance("writes another each time a child's state changes", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const session = yield* sessions.create({ title: "root" })
      const child = yield* sessions.create({ parentID: session.id, title: "child" })

      let messages: SessionV1.WithParts[] = []
      const turn = Effect.fn("RosterTest.turn")(function* () {
        messages = yield* applyAgentRoster({ messages: [...messages, yield* userMessage(session.id)], session })
        return rosterParts(messages).length
      })

      yield* status.set(child.id, { type: "busy" })
      expect(yield* turn()).toBe(1)

      yield* status.set(child.id, { type: "idle" })
      expect(yield* turn()).toBe(2)

      // Woken again through agent_send, and again after that.
      yield* status.set(child.id, { type: "busy" })
      expect(yield* turn()).toBe(3)

      yield* status.set(child.id, { type: "idle" })
      expect(yield* turn()).toBe(4)
    }),
  )

  // A roster and agent_list expose the same thing, so a session denied the tool
  // is not handed the list by a different route.
  it.instance("says nothing when the session is denied agent_list", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "root",
        permission: [{ permission: "agent_list", pattern: "*", action: "deny" }],
      })
      yield* sessions.create({ parentID: session.id, title: "child" })
      const messages = [yield* userMessage(session.id)]

      const out = yield* applyAgentRoster({ messages, session })
      expect(rosterParts(out)).toHaveLength(0)
    }),
  )

  // Compaction replaces the start notice and the completion notice with a
  // summary, so the roster has to come back even mid-turn.
  it.instance("writes one after a compaction even with an assistant message present", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "root" })
      yield* sessions.create({ parentID: session.id, title: "child" })

      const user = yield* userMessage(session.id)
      const compaction = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: user.info.id,
        sessionID: session.id,
        type: "compaction",
        auto: true,
      } satisfies SessionV1.CompactionPart)
      user.parts.push(compaction)

      const out = yield* applyAgentRoster({ messages: [user, yield* assistantAfter(user)], session })
      expect(rosterParts(out)).toHaveLength(1)
    }),
  )

  // Only until one comes back. Otherwise every step for the rest of the session
  // would qualify, which is the per-step evaluation this design exists to leave
  // behind.
  it.instance("stops treating a compaction as a trigger once a roster follows it", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "root" })
      const child = yield* sessions.create({ parentID: session.id, title: "child" })

      const user = yield* userMessage(session.id)
      const compaction = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: user.info.id,
        sessionID: session.id,
        type: "compaction",
        auto: true,
      } satisfies SessionV1.CompactionPart)
      user.parts.push(compaction)

      const withRoster = yield* applyAgentRoster({ messages: [user, yield* assistantAfter(user)], session })
      expect(rosterParts(withRoster)).toHaveLength(1)

      // A second child changes the roster's content, so only the trigger can be
      // what keeps this step quiet.
      yield* sessions.create({ parentID: session.id, title: "another" })
      void child
      const later = yield* applyAgentRoster({
        messages: [...withRoster, yield* assistantAfter(user)],
        session,
      })
      expect(rosterParts(later)).toHaveLength(1)
    }),
  )
})
