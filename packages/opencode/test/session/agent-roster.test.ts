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
import { AgentManagement } from "@/agent-management/schema"
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
      const status = yield* SessionStatus.Service
      const session = yield* sessions.create({ title: "root" })
      const child = yield* sessions.create({ parentID: session.id, title: "child doing a thing" })
      yield* status.set(child.id, { type: "busy" })
      const messages = [yield* userMessage(session.id)]

      const out = yield* applyAgentRoster({ messages, session })
      const written = rosterParts(out)
      expect(written).toHaveLength(1)
      const text = written[0].type === "text" ? written[0].text : ""
      expect(text).toContain(child.id)
      // The title is the brief; it is what tells the reader what the child is for.
      expect(text).toContain("child doing a thing")
      // Facts only: no tool is named, and no status word -- everything listed
      // is running by construction.
      expect(text).toContain("working right now")
      expect(text).not.toContain("agent_list")
      expect(text).not.toContain("idle")
    }),
  )

  // The reason this test exists: the list used to be every child the session
  // had ever started. On one real session it reached 133 rows of which 6 were
  // running, and came to 58% of the text in the recent window.
  it.instance("lists only the children that are running", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const session = yield* sessions.create({ title: "root" })
      const busy = yield* sessions.create({ parentID: session.id, title: "busy one" })
      const done = yield* sessions.create({ parentID: session.id, title: "finished one" })
      yield* status.set(busy.id, { type: "busy" })
      yield* status.set(done.id, { type: "idle" })
      const messages = [yield* userMessage(session.id)]

      const out = yield* applyAgentRoster({ messages, session })
      const text = rosterParts(out).map((p) => (p.type === "text" ? p.text : "")).join("")
      expect(text).toContain(busy.id)
      expect(text).not.toContain(done.id)
      expect(text).not.toContain("finished one")
    }),
  )

  // A parent whose children have all finished keeps the one fact that it has
  // them, in a line, rather than the roster vanishing as if it never had any.
  it.instance("says in one line that nothing is running, with the count", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "root" })
      yield* sessions.create({ parentID: session.id, title: "a" })
      yield* sessions.create({ parentID: session.id, title: "b" })
      const messages = [yield* userMessage(session.id)]

      const out = yield* applyAgentRoster({ messages, session })
      const written = rosterParts(out)
      expect(written).toHaveLength(1)
      const text = written[0].type === "text" ? written[0].text : ""
      expect(text).toContain("none (2 finished)")
      expect(text.split("\n").filter((line) => line.startsWith("  ses_"))).toHaveLength(0)
      expect(text).not.toContain("agent_list")
    }),
  )

  it.instance("caps the list and says how many it left out", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const session = yield* sessions.create({ title: "root" })
      for (let i = 0; i < AgentManagement.ROSTER_MAX_ROWS + 2; i++) {
        const child = yield* sessions.create({ parentID: session.id, title: `lane ${i}` })
        yield* status.set(child.id, { type: "busy" })
      }
      const messages = [yield* userMessage(session.id)]

      const out = yield* applyAgentRoster({ messages, session })
      const text = rosterParts(out).map((p) => (p.type === "text" ? p.text : "")).join("")
      expect(text.split("\n").filter((line) => line.startsWith("  ses_"))).toHaveLength(AgentManagement.ROSTER_MAX_ROWS)
      expect(text).toContain("2 more are running.")
      expect(text).not.toContain("agent_list")
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

  // The agent's own ruleset is where a user writes the rule; the session carries
  // what was derived for this run. Checking only the session would miss it.
  it.instance("says nothing when the agent definition denies agent_list", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "root" })
      yield* sessions.create({ parentID: session.id, title: "child" })
      const messages = [yield* userMessage(session.id)]

      const out = yield* applyAgentRoster({
        messages,
        session,
        agent: { permission: [{ permission: "agent_list", pattern: "*", action: "deny" }] } as Agent.Info,
      })
      expect(rosterParts(out)).toHaveLength(0)
    }),
  )

  // A name comes from the model, and a newline in one would forge a row.
  // Name and title both reach a line this writes, and both come from the
  // model -- the title is the description the parent gave when it started the
  // child, so a newline can land there as easily as in a name.
  it.instance("escapes a child name or title that would otherwise forge a row", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const session = yield* sessions.create({ title: "root" })
      const child = yield* sessions.create({
        parentID: session.id,
        title: "honest\n  ses_fake2  — forged by title",
        metadata: { agentName: "real\n  ses_fake  forged" },
      })
      yield* status.set(child.id, { type: "busy" })
      const messages = [yield* userMessage(session.id)]

      const out = yield* applyAgentRoster({ messages, session })
      const written = rosterParts(out)
      expect(written).toHaveLength(1)
      const text = written[0].type === "text" ? written[0].text : ""
      // Sentinel, heading, exactly one row, whatever the fields contain. The
      // forged rows are still legible inside the values — encoding keeps them
      // rather than redacting — they just no longer start lines of their own.
      expect(text.split("\n")).toHaveLength(3)
      expect(text).not.toContain("\n  ses_fake")
      expect(text).toContain("real\\n")
      expect(text).toContain("honest\\n")
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
