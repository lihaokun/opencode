import { describe, expect, test } from "bun:test"
import type { IncompleteStreamRecovery } from "@opencode-ai/schema/session-recovery"
import { Schema } from "effect"
import fc from "fast-check"
import {
  INCOMPLETE_STREAM_RETRY_BACKOFF_FACTOR,
  INCOMPLETE_STREAM_RETRY_INITIAL_DELAY_MS,
  INCOMPLETE_STREAM_RETRY_LIMIT,
  classifyIncompleteStreamRecovery,
  incompleteStreamRetryDelay,
  isSettledIncompleteStreamTool,
} from "../src/session/incomplete-stream-recovery"
import { Info as RecoverySchema } from "@opencode-ai/schema/session-recovery"

const tool = (
  overrides: Partial<IncompleteStreamRecovery.ToolEvidence> = {},
): IncompleteStreamRecovery.ToolEvidence => ({
  id: "call_1",
  name: "bash",
  state: "completed",
  completeCall: true,
  inputPersisted: true,
  providerExecuted: true,
  terminalResultPersisted: true,
  interrupted: false,
  ...overrides,
})

const classify = (overrides: Partial<Parameters<typeof classifyIncompleteStreamRecovery>[0]> = {}) =>
  classifyIncompleteStreamRecovery({
    attempt: 0,
    limit: INCOMPLETE_STREAM_RETRY_LIMIT,
    blocked: false,
    persistenceFailed: false,
    tools: [],
    ...overrides,
  })

describe("incomplete stream recovery classifier", () => {
  test("implements the complete decision table", () => {
    expect(classify()).toMatchObject({
      classification: "incomplete-stream",
      action: "safe-retry",
      reason: "no-tool-evidence",
      retry: { attempt: 0, limit: 2 },
    })
    expect(classify({ attempt: 2 })).toMatchObject({ action: "manual-stop", reason: "retry-exhausted" })
    expect(classify({ tools: [tool()] })).toMatchObject({
      action: "continue-after-settled-tools",
      reason: "settled-tools",
    })
    expect(classify({ tools: [tool({ state: "error" })] })).toMatchObject({
      action: "continue-after-settled-tools",
      reason: "settled-tools",
    })
    expect(classify({ tools: [tool({ state: "running", terminalResultPersisted: false })] })).toMatchObject({
      action: "manual-stop",
      reason: "uncertain-side-effect",
    })
    expect(classify({ tools: [tool({ interrupted: true })] })).toMatchObject({
      action: "manual-stop",
      reason: "uncertain-side-effect",
    })
    expect(classify({ blocked: true })).toMatchObject({ action: "manual-stop", reason: "blocked" })
    expect(classify({ persistenceFailed: true })).toMatchObject({
      action: "manual-stop",
      reason: "persistence-failure",
    })
    expect(classify({ blocked: true, persistenceFailed: true })).toMatchObject({
      action: "manual-stop",
      reason: "blocked",
    })
  })

  test("fails closed and sanitizes invalid evidence", () => {
    const implication = classify({ tools: [tool({ completeCall: false })] })
    expect(implication).toMatchObject({ action: "manual-stop", reason: "persistence-failure", tools: [] })

    const duplicate = classify({ tools: [tool(), tool({ name: "read" })] })
    expect(duplicate).toMatchObject({ action: "manual-stop", reason: "persistence-failure", tools: [] })

    const invalidAttempt = classify({ attempt: 3, limit: 2 })
    expect(invalidAttempt).toEqual({
      classification: "incomplete-stream",
      action: "manual-stop",
      reason: "persistence-failure",
      tools: [],
      retry: { attempt: 2, limit: 2 },
    })
    expect(Schema.decodeUnknownSync(RecoverySchema)(invalidAttempt)).toEqual(invalidAttempt)
  })

  test("uses the bounded deterministic retry policy", () => {
    expect(INCOMPLETE_STREAM_RETRY_LIMIT).toBe(2)
    expect(INCOMPLETE_STREAM_RETRY_INITIAL_DELAY_MS).toBe(2_000)
    expect(INCOMPLETE_STREAM_RETRY_BACKOFF_FACTOR).toBe(2)
    expect(incompleteStreamRetryDelay(1)).toBe(2_000)
    expect(incompleteStreamRetryDelay(2)).toBe(4_000)
    expect(incompleteStreamRetryDelay(0)).toBeUndefined()
    expect(incompleteStreamRetryDelay(3)).toBeUndefined()
    expect(incompleteStreamRetryDelay(1.5)).toBeUndefined()
  })
})

const stateArbitrary = fc.constantFrom<IncompleteStreamRecovery.ToolState>("pending", "running", "completed", "error")
const toolArbitrary = fc.record({
  id: fc.string({ minLength: 1, maxLength: 24 }),
  name: fc.string({ minLength: 1, maxLength: 24 }),
  state: stateArbitrary,
  completeCall: fc.boolean(),
  inputPersisted: fc.boolean(),
  providerExecuted: fc.boolean(),
  terminalResultPersisted: fc.boolean(),
  interrupted: fc.boolean(),
})
const retryArbitrary = fc
  .integer({ min: 0, max: 8 })
  .chain((limit) => fc.integer({ min: 0, max: limit }).map((attempt) => ({ attempt, limit })))
const settledToolArbitrary = fc.record({
  id: fc.uuid(),
  name: fc.string({ minLength: 1, maxLength: 24 }),
  state: fc.constantFrom<IncompleteStreamRecovery.ToolState>("completed", "error"),
  completeCall: fc.constant(true),
  inputPersisted: fc.constant(true),
  providerExecuted: fc.constant(true),
  terminalResultPersisted: fc.constant(true),
  interrupted: fc.constant(false),
})

describe("incomplete stream recovery properties", () => {
  test("SafeRetry and Continue can only arise under their contracted evidence", () => {
    fc.assert(
      fc.property(
        retryArbitrary,
        fc.array(toolArbitrary, { maxLength: 20 }),
        fc.boolean(),
        fc.boolean(),
        ({ attempt, limit }, tools, blocked, persistenceFailed) => {
          const result = classifyIncompleteStreamRecovery({ attempt, limit, tools, blocked, persistenceFailed })
          expect(() => Schema.decodeUnknownSync(RecoverySchema)(result)).not.toThrow()
          if (result.action === "safe-retry") {
            expect(result.tools).toHaveLength(0)
            expect(result.retry.attempt).toBeLessThan(result.retry.limit)
            expect(result.reason).toBe("no-tool-evidence")
          }
          if (result.action === "continue-after-settled-tools") {
            expect(result.tools.length).toBeGreaterThan(0)
            expect(result.tools.every(isSettledIncompleteStreamTool)).toBe(true)
            expect(result.reason).toBe("settled-tools")
          }
        },
      ),
    )
  })

  test("any tool evidence excludes SafeRetry", () => {
    fc.assert(
      fc.property(
        retryArbitrary,
        fc.array(toolArbitrary, { minLength: 1, maxLength: 20 }),
        ({ attempt, limit }, tools) => {
          expect(
            classifyIncompleteStreamRecovery({
              attempt,
              limit,
              tools,
              blocked: false,
              persistenceFailed: false,
            }).action,
          ).not.toBe("safe-retry")
        },
      ),
    )
  })

  test("all unique settled tools continue even when the retry budget is exhausted", () => {
    fc.assert(
      fc.property(
        retryArbitrary,
        fc.uniqueArray(settledToolArbitrary, { selector: (value) => value.id, minLength: 1, maxLength: 20 }),
        ({ attempt, limit }, tools) => {
          expect(
            classifyIncompleteStreamRecovery({
              attempt,
              limit,
              tools,
              blocked: false,
              persistenceFailed: false,
            }),
          ).toMatchObject({ action: "continue-after-settled-tools", reason: "settled-tools" })
        },
      ),
    )
  })

  test("blocked and persistence failure dominate otherwise safe evidence", () => {
    fc.assert(
      fc.property(retryArbitrary, ({ attempt, limit }) => {
        expect(
          classifyIncompleteStreamRecovery({ attempt, limit, tools: [], blocked: true, persistenceFailed: false }),
        ).toMatchObject({ action: "manual-stop", reason: "blocked" })
        expect(
          classifyIncompleteStreamRecovery({ attempt, limit, tools: [], blocked: false, persistenceFailed: true }),
        ).toMatchObject({ action: "manual-stop", reason: "persistence-failure" })
      }),
    )
  })
})
