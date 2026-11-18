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
