import { describe, expect, test } from "bun:test"
import * as DoomLoop from "../../src/session/doom-loop"

type Call = {
  tool: string
  input: Record<string, unknown>
}

function calls(pattern: readonly Call[], repetitions: number) {
  return Array.from({ length: repetitions }, () => pattern).flat()
}

function results(sequence: readonly Call[], maxPeriod?: number) {
  const detector = maxPeriod === undefined ? DoomLoop.create() : DoomLoop.create(maxPeriod)
  return sequence.map((call) => detector.check(call.tool, call.input))
}

function signature(call: Call) {
  return JSON.stringify([call.tool, call.input])
}

function oracle(sequence: readonly Call[], maxPeriod: number) {
  const signatures = sequence.map(signature)
  for (let period = 1; period <= maxPeriod; period++) {
    if (signatures.length < 3 * period) continue
    const start = signatures.length - 3 * period
    let same = true
    for (let offset = 0; offset < period; offset++) {
      const first = signatures[start + offset]
      if (first !== signatures[start + period + offset] || first !== signatures[start + 2 * period + offset]) {
        same = false
        break
      }
    }
    if (same) return true
  }
  return false
}

describe("doom-loop detector", () => {
  test("detects period 1 on the third identical call", () => {
    const call = { tool: "lookup", input: { query: "a" } }
    expect(results([call, call, call])).toEqual([false, false, true])
  })

  test("detects period 10 at the end of the third repetition", () => {
    const pattern = Array.from({ length: DoomLoop.MAX_PERIOD }, (_, index) => ({
      tool: `tool-${index}`,
      input: { value: index },
    }))
    const detected = results(calls(pattern, 3))
    expect(detected.slice(0, -1).every((value) => !value)).toBe(true)
    expect(detected.at(-1)).toBe(true)
  })

  test("does not detect only two repetitions", () => {
    const pattern = Array.from({ length: DoomLoop.MAX_PERIOD }, (_, index) => ({
      tool: `tool-${index}`,
      input: { value: index },
    }))
    expect(results(calls(pattern, 2)).every((value) => !value)).toBe(true)
  })

  test("resets a candidate period when one input changes", () => {
    const pattern = Array.from({ length: DoomLoop.MAX_PERIOD }, (_, index) => ({
      tool: `tool-${index}`,
      input: { value: index },
    }))
    const changed = pattern.map((call, index) => (index === 5 ? { ...call, input: { value: "changed" } } : call))
    expect(results([...calls(pattern, 2), ...changed]).every((value) => !value)).toBe(true)
  })

  test("does not detect non-periodic interleaved calls", () => {
    const sequence = Array.from({ length: 40 }, (_, index) => ({
      tool: `tool-${index % 7}`,
      input: { value: index },
    }))
    expect(results(sequence).every((value) => !value)).toBe(true)
  })

  test("detects the smallest fundamental period", () => {
    const a = { tool: "a", input: { value: "a" } }
    const b = { tool: "b", input: { value: "b" } }
    const detected = results(calls([a, b, a, b], 3))
    expect(detected.findIndex(Boolean)).toBe(5)
  })

  test("preserves JSON.stringify object-key ordering semantics", () => {
    const sequence = [
      { tool: "lookup", input: { a: 1, b: 2 } },
      { tool: "lookup", input: { b: 2, a: 1 } },
      { tool: "lookup", input: { a: 1, b: 2 } },
    ]
    expect(results(sequence)).toEqual([false, false, false])
  })

  test("detects a maximum-period cycle after the ring wraps", () => {
    const noise = Array.from({ length: 2 * DoomLoop.MAX_PERIOD + 5 }, (_, index) => ({
      tool: "noise",
      input: { value: index },
    }))
    const pattern = Array.from({ length: DoomLoop.MAX_PERIOD }, (_, index) => ({
      tool: `tool-${index}`,
      input: { value: index },
    }))
    const detected = results([...noise, ...calls(pattern, 3)])
    expect(detected.slice(0, -1).every((value) => !value)).toBe(true)
    expect(detected.at(-1)).toBe(true)
  })

  test("matches an independent brute-force oracle", () => {
    const alphabet = [
      { tool: "a", input: { value: 0 } },
      { tool: "b", input: { value: 1 } },
    ] satisfies readonly Call[]

    for (let length = 1; length <= 10; length++) {
      for (let mask = 0; mask < 1 << length; mask++) {
        const detector = DoomLoop.create(3)
        const sequence: Call[] = []
        for (let index = 0; index < length; index++) {
          const call = alphabet[(mask >> index) & 1]
          sequence.push(call)
          expect(detector.check(call.tool, call.input)).toBe(oracle(sequence, 3))
        }
      }
    }
  })
})
