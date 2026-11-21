import { describe, expect, test } from "bun:test"
import { FastCheck } from "effect/testing"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

function history() {
  const sessionID = SessionID.make("ses_projection")
  const messages: SessionV1.WithParts[] = []
  const hidden = new Set<MessageID>()
  const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }
  const info = () => {
    // This generator supplies chronological input. Same-time tie-breaking is
    // covered by the database/chronology suite, not inferred from array order.
    const created = 2 ** 36 - 3 + messages.length
    return { id: MessageID.make(Identifier.create("msg", "ascending", created)), sessionID, time: { created } }
  }
  const append = (message: SessionV1.WithParts) => {
    messages.push(message)
    return message
  }
  const user = () => append({ info: { ...info(), role: "user", agent: "build", model }, parts: [] })
  const assistant = (
    parent: SessionV1.WithParts,
    state: "ordinary" | "success" | "error" | "cancelled" | "unfinished",
  ) => {
    const message = append({
      info: {
        ...info(),
        role: "assistant",
        parentID: parent.info.id,
        agent: "build",
        mode: "build",
        providerID: model.providerID,
        modelID: model.modelID,
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        summary: state !== "ordinary",
        finish: state === "unfinished" ? undefined : "stop",
        error:
          state === "error"
            ? new SessionV1.OutputLengthError({}).toObject()
            : state === "cancelled"
              ? new SessionV1.AbortedError({ message: "cancelled" }).toObject()
              : undefined,
      },
      parts: [],
    })
    if (state === "error" || state === "cancelled" || state === "unfinished") hidden.add(message.info.id)
    return message
  }
  const marker = (tail?: SessionV1.WithParts) => {
    const message = user()
    message.parts.push({
      id: PartID.ascending(),
      sessionID,
      messageID: message.info.id,
      type: "compaction",
      auto: true,
      tail_start_id: tail?.info.id,
    })
    return message
  }
  const check = (expected: SessionV1.WithParts[], label: string) => {
    const before = structuredClone(messages)
    const result = MessageV2.filterCompacted(messages.toReversed())
    expect(
      result.map((message) => message.info.id),
      label,
    ).toEqual(expected.filter((message) => !hidden.has(message.info.id)).map((message) => message.info.id))
    expect(messages, label).toEqual(before)
  }
  return { messages, user, assistant, marker, check }
}

describe("compaction projection boundaries", () => {
  test("ordinary failed and unfinished assistants remain in the history projection", () => {
    const h = history()
    const user = h.user()
    const failed = h.assistant(user, "ordinary")
    const unfinished = h.assistant(user, "ordinary")
    if (failed.info.role !== "assistant" || unfinished.info.role !== "assistant") throw new Error("expected assistants")
    failed.info.error = new SessionV1.AbortedError({ message: "cancelled" }).toObject()
    unfinished.info.finish = undefined
    h.check([user, failed, unfinished], "only summary failures are hidden")
  })

  for (const state of ["error", "cancelled", "unfinished"] as const) {
    test(`a hidden ${state} summary still defines the persisted tail boundary`, () => {
      const h = history()
      const old = h.user()
      const failed = h.assistant(old, state)
      const retained = h.user()
      const marker = h.marker(failed)
      const summary = h.assistant(marker, "success")
      h.check([marker, summary, retained], state)
    })
  }

  for (const retain of [false, true]) {
    test(`late messages follow the summary and retained tail (retain=${retain})`, () => {
      const h = history()
      h.user()
      const tail = h.user()
      const marker = h.marker(retain ? tail : undefined)
      const late = h.user()
      const summary = h.assistant(marker, "success")
      h.check([marker, summary, ...(retain ? [tail] : []), late], "late before summary")
      const pending = h.marker(tail)
      h.assistant(pending, "error")
      h.check(
        [marker, summary, ...(retain ? [tail] : []), late, pending],
        "pending marker cannot replace a settled boundary",
      )
    })
  }

  // The oracle records the intervals chosen by the generated events. It does
  // not scan for boundaries or call latest/filterCompacted to build expected.
  test("generated compaction event histories preserve exactly the selected intervals", () => {
    const coverage = new Set<string>()
    const state = FastCheck.constantFrom("error", "cancelled", "unfinished")
    const cycle = FastCheck.record({
      state,
      cut: FastCheck.integer({ min: 0, max: 4 }),
      attempts: FastCheck.array(FastCheck.record({ state, arrivals: FastCheck.integer({ min: 0, max: 3 }) }), {
        maxLength: 3,
      }),
      arrivals: FastCheck.integer({ min: 0, max: 3 }),
      after: FastCheck.integer({ min: 0, max: 3 }),
    })
    FastCheck.assert(
      FastCheck.property(FastCheck.array(cycle, { minLength: 1, maxLength: 4 }), (cycles) => {
        const h = history()
        let expected = [h.user()]
        for (const [index, cycle] of cycles.entries()) {
          const tailUser = h.user()
          const tailAssistant = h.assistant(tailUser, "ordinary")
          const failed = h.assistant(tailUser, cycle.state)
          const recent = h.user()
          const group = [tailUser, tailAssistant, failed, recent]
          expected.push(...group)
          coverage.add(`tail:${cycle.cut}`)
          coverage.add(cycle.state)
          const tail = cycle.cut === 4 ? [] : group.slice(cycle.cut)
          const marker = h.marker(tail[0])
          expected.push(marker)
          h.check(expected, `cycle=${index} admitted`)
          const late: SessionV1.WithParts[] = []
          for (const [attempt, action] of cycle.attempts.entries()) {
            for (let i = 0; i < action.arrivals; i++) {
              const message = h.user()
              late.push(message)
              expected.push(message)
            }
            const failed = h.assistant(marker, action.state)
            expected.push(failed)
            h.check(expected, `cycle=${index} attempt=${attempt}`)
          }
          late.push(...Array.from({ length: cycle.arrivals }, () => h.user()))
          const summary = h.assistant(marker, "success")
          expected = [marker, summary, ...tail, ...late]
          h.check(expected, `cycle=${index} settled`)
          const after = Array.from({ length: cycle.after }, () => h.user())
          expected.push(...after)
          h.check(expected, `cycle=${index} after`)
        }
      }),
      { seed: 86077, numRuns: 200 },
    )
    expect([...coverage].sort()).toEqual([
      "cancelled",
      "error",
      "tail:0",
      "tail:1",
      "tail:2",
      "tail:3",
      "tail:4",
      "unfinished",
    ])
  })
})
