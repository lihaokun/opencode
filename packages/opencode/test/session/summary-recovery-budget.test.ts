import { tool, jsonSchema } from "ai"
import { expect, test } from "bun:test"
import { FastCheck } from "effect/testing"
import {
  firstStage,
  providerGap,
  calibratedInput,
  recoveryBoundaries,
  estimatePayload,
} from "../../src/session/summary-budget"
import { pendingInputStart } from "../../src/session/prompt"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

test("7% starts at 10%, with explicit provider counts taking priority", () => {
  expect(providerGap("Prompt exceeds max length")).toBeUndefined()
  expect(providerGap("prompt is too long: 107,000 tokens > 100,000 maximum")).toBe(7000)
  expect(providerGap("maximum context length of 100000 tokens. You requested a total of 107000 tokens")).toBe(7000)
  expect(firstStage(7000, 100000)).toBe(10)
  expect(calibratedInput(108000, { actual: 90000, estimate: 91000 })).toBe(107000)
  expect(calibratedInput(108000)).toBe(108000)
})

test("PBT: start is the smallest available five-percent stage covering the deficit", () => {
  FastCheck.assert(
    FastCheck.property(
      FastCheck.integer({ min: 1, max: 1_000_000 }),
      FastCheck.integer({ min: -1000, max: 1_000_000 }),
      (budget, gap) => {
        const stages = [5, 10, 15, 20, 25]
        expect(firstStage(gap, budget)).toBe(stages.find((p) => budget * p >= 100 * gap) ?? 25)
      },
    ),
    { numRuns: 500 },
  )
})

test("PBT: candidates actually sent are whole groups and the earliest boundary covering each reachable stage", () => {
  FastCheck.assert(
    FastCheck.property(
      FastCheck.array(FastCheck.integer({ min: 1, max: 12 }), { maxLength: 35 }),
      FastCheck.integer({ min: 0, max: 40 }),
      (sizes, gap) => {
        let sum = 0
        const groups = sizes
          .map((n, i) => ({ start: sizes.length - i, reduction: (sum += n) }))
          .filter((g) => g.reduction <= 25)
        const plan = recoveryBoundaries(100, gap, groups)
        let cursor = plan.next()
        const sent: number[] = []
        while (!cursor.done) {
          const { start, target } = cursor.value
          const candidate = groups.find((g) => g.start === start)!
          if (candidate.reduction < target) {
            cursor = plan.next(undefined)
            continue
          }
          sent.push(candidate.start)
          cursor = plan.next(candidate.reduction)
        }
        const stages = [5, 10, 15, 20, 25]
        const first = stages.find((n) => n >= gap) ?? 25
        const expected = new Set(
          stages
            .filter((n) => n >= first)
            .map((n) => groups.find((g) => g.reduction >= n)?.start)
            .filter((n) => n !== undefined),
        )
        expect(sent).toEqual([...expected])
      },
    ),
    { numRuns: 500 },
  )
})

test("payload estimate includes system, reasoning, tool name/input, and effective schema", async () => {
  const schema = { type: "object", properties: { query: { type: "string" } } } as const
  const input = { query: "hello" }
  const amount = (chars: number) => Math.ceil(chars / 3)
  const size = await estimatePayload({
    system: ["sys"],
    messages: [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "abc" },
          { type: "tool-call", toolName: "lookup", toolCallId: "an-opaque-id", input },
        ],
      },
    ],
    tools: { lookup: tool({ description: "find", inputSchema: jsonSchema(schema) }) },
  })
  expect(size).toBe(1 + amount(3 + 6 + JSON.stringify(input).length) + amount(6 + 4 + JSON.stringify(schema).length))
})

test("PBT: transformed payloads reach increasing targets or skip the provider call", () => {
  FastCheck.assert(
    FastCheck.property(
      FastCheck.array(FastCheck.tuple(FastCheck.integer({ min: 1, max: 4 }), FastCheck.integer({ min: -8, max: 8 })), {
        minLength: 1,
        maxLength: 24,
      }),
      (data) => {
        let estimated = 0
        const groups = data.map(([weight, delta], i) => ({
          start: data.length - i,
          reduction: (estimated += weight),
          actual: estimated + delta,
        }))
        const plan = recoveryBoundaries(100, 0, groups)
        let cursor = plan.next()
        let last = 0
        const calls: number[] = []
        while (!cursor.done) {
          const { start, target } = cursor.value
          const actual = groups[data.length - start]!.actual
          expect(target).toBe(5 * (Math.floor(last / 5) + 1))
          if (actual < target) {
            cursor = plan.next(undefined)
            continue
          }
          expect(actual).toBeGreaterThan(last)
          calls.push(start)
          last = actual
          cursor = plan.next(actual)
        }
        expect(calls.length).toBeLessThanOrEqual(5)
        expect(calls).toEqual([...new Set(calls)].toSorted((a, b) => b - a))
      },
    ),
    { numRuns: 250 },
  )
})

test("PBT: pendingInputStart preserves all unanswered users across error, tool-calls, unknown, and inherited continues", () => {
  const sessionID = SessionID.make("ses_pbt_pending")
  const itemKind = FastCheck.constantFrom(
    "user" as const,
    "continue" as const,
    "assistant_stop" as const,
    "assistant_length" as const,
    "assistant_error" as const,
    "assistant_tool_calls" as const,
    "assistant_unknown" as const,
    "assistant_summary" as const,
  )
  const makeMsg = (
    seq: number,
    kind:
      | "marker"
      | "user"
      | "continue"
      | "assistant_stop"
      | "assistant_length"
      | "assistant_error"
      | "assistant_tool_calls"
      | "assistant_unknown"
      | "assistant_summary",
    protectedFrom?: MessageID,
  ): SessionV1.WithParts => {
    const id = MessageID.make(`msg_${String(seq).padStart(4, "0")}`)
    const time = { created: 1000 + seq }
    if (kind === "marker") {
      return {
        info: {
          id,
          role: "user",
          sessionID,
          agent: "build",
          model: { providerID: "test", modelID: "test" },
          time,
        },
        parts: [{ id: PartID.make(`prt_${seq}`), messageID: id, sessionID, type: "compaction", auto: true }],
      } as unknown as SessionV1.WithParts
    }
    if (kind === "user" || kind === "continue") {
      return {
        info: {
          id,
          role: "user",
          sessionID,
          agent: "build",
          model: { providerID: "test", modelID: "test" },
          time,
        },
        parts: [
          {
            id: PartID.make(`prt_${seq}`),
            messageID: id,
            sessionID,
            type: "text",
            text: kind === "continue" ? "continue" : `user-${seq}`,
            ...(kind === "continue"
              ? {
                  synthetic: true,
                  metadata: { compaction_continue: true, ...(protectedFrom ? { protected_from: protectedFrom } : {}) },
                }
              : {}),
          },
        ],
      } as unknown as SessionV1.WithParts
    }
    const finish =
      kind === "assistant_stop" || kind === "assistant_summary"
        ? "stop"
        : kind === "assistant_length"
          ? "length"
          : kind === "assistant_error"
            ? "error"
            : kind === "assistant_tool_calls"
              ? "tool-calls"
              : "unknown"
    return {
      info: {
        id,
        parentID: id,
        role: "assistant",
        sessionID,
        agent: "build",
        mode: "build",
        finish,
        ...(kind === "assistant_summary" ? { summary: true } : {}),
        ...(kind === "assistant_error" ? { error: { name: "UnknownError", data: { message: "boom" } } } : {}),
        time,
      },
      parts: [],
    } as unknown as SessionV1.WithParts
  }

  FastCheck.assert(
    FastCheck.property(
      FastCheck.boolean(),
      FastCheck.array(FastCheck.tuple(itemKind, FastCheck.nat(10)), { minLength: 0, maxLength: 20 }),
      (hasMarker, entries) => {
        const messages: SessionV1.WithParts[] = []
        const userIndices: number[] = []
        let seq = 1
        if (hasMarker) {
          messages.push(makeMsg(seq++, "marker"))
          messages.push(makeMsg(seq++, "assistant_summary"))
        }
        for (const [kind, pick] of entries) {
          const inherited =
            kind === "continue" && userIndices.length > 0
              ? messages[userIndices[pick % userIndices.length]!]!.info.id
              : undefined
          const msg = makeMsg(seq++, kind, inherited)
          if (kind === "user") userIndices.push(messages.length)
          messages.push(msg)
        }
        const current = messages.length
        messages.push(makeMsg(seq++, "user"))

        // Independent oracle: scan back to the last terminal non-error non-summary assistant or compaction marker.
        let barrier = hasMarker ? 0 : -1
        for (let i = current - 1; i > barrier; i--) {
          const info = messages[i]!.info
          if (
            info.role === "assistant" &&
            !info.summary &&
            !info.error &&
            (info.finish === "stop" || info.finish === "length")
          ) {
            barrier = i
            break
          }
        }
        let expected = current
        const inheritedIDs = new Set<string>()
        for (let i = barrier + 1; i <= current; i++) {
          const row = messages[i]!
          if (row.info.role !== "user") continue
          const ctrl = row.parts.find((p) => p.type === "text" && p.synthetic && p.metadata?.compaction_continue)
          if (ctrl?.type === "text") {
            if (typeof ctrl.metadata?.protected_from === "string") inheritedIDs.add(ctrl.metadata.protected_from)
            continue
          }
          expected = Math.min(expected, i)
        }
        for (let i = 0; i < messages.length; i++) {
          if (messages[i]!.info.role === "user" && inheritedIDs.has(messages[i]!.info.id)) {
            expected = Math.min(expected, i)
            break
          }
        }

        expect(pendingInputStart(messages, current)).toBe(expected)
      },
    ),
    { seed: 600801, numRuns: 500 },
  )
})
