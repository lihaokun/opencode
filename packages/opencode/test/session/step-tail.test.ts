import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { StepTail } from "../../src/session/step-tail"

type Call = { tool: string; input: Record<string, unknown>; status: "completed" | "error"; result: string }

function part(call: Call, index: number): SessionV1.Part {
  const time = { start: index, end: index + 1 }
  const state =
    call.status === "completed"
      ? { status: "completed" as const, input: call.input, output: call.result, title: "", metadata: {}, time }
      : { status: "error" as const, input: call.input, error: call.result, time }
  return {
    id: `prt_${index}`,
    sessionID: "ses_test",
    messageID: "msg_test",
    type: "tool",
    callID: `call_${index}`,
    tool: call.tool,
    state,
  } as SessionV1.Part
}

function step(calls: Call[]) {
  return StepTail.signature(calls.map(part))
}

const edit: Call = {
  tool: "edit",
  input: { filePath: "a.v", oldString: "i))))))", newString: "i))))))" },
  status: "error",
  result: "No changes to apply: oldString and newString are identical.",
}

describe("step tail: signature", () => {
  test("keeps tool calls and results in emission order, ignoring other parts", () => {
    const text = {
      id: "prt_t",
      sessionID: "ses_test",
      messageID: "msg_test",
      type: "text",
      text: "x",
    } as SessionV1.Part
    const signature = StepTail.signature([text, part(edit, 1)])
    expect(signature.calls).toEqual([JSON.stringify(["edit", edit.input])])
    expect(signature.results).toEqual([JSON.stringify(["error", edit.result])])
  })
})

describe("step tail: nextRepeat", () => {
  test("the fermat storm: the same failing edit every step counts up on both counters", () => {
    let repeat = StepTail.NO_REPEAT
    let previous: StepTail.StepSignature | undefined
    const seen: StepTail.Repeat[] = []
    for (let i = 0; i < 5; i++) {
      const current = step([edit])
      repeat = StepTail.nextRepeat(previous, current, repeat)
      previous = current
      seen.push(repeat)
    }
    expect(seen).toEqual([
      { calls: 0, results: 0 },
      { calls: 1, results: 1 },
      { calls: 2, results: 2 },
      { calls: 3, results: 3 },
      { calls: 4, results: 4 },
    ])
  })

  test("polling with changing results counts the calls only", () => {
    const poll = (result: string): Call => ({
      tool: "bash",
      input: { command: "sleep 300; check" },
      status: "completed",
      result,
    })
    const first = step([poll("RUNNING")])
    const second = step([poll("RUNNING")])
    const third = step([poll("DONE")])
    const a = StepTail.nextRepeat(first, second, StepTail.NO_REPEAT)
    expect(a).toEqual({ calls: 1, results: 1 })
    expect(StepTail.nextRepeat(second, third, a)).toEqual({ calls: 2, results: 0 })
  })

  test("a different call, an empty step, or no previous step clears both counters", () => {
    const other = step([{ ...edit, input: { ...edit.input, newString: "i)))))))" } }])
    const busy = { calls: 3, results: 2 }
    expect(StepTail.nextRepeat(step([edit]), other, busy)).toEqual(StepTail.NO_REPEAT)
    expect(StepTail.nextRepeat(step([edit]), step([]), busy)).toEqual(StepTail.NO_REPEAT)
    expect(StepTail.nextRepeat(undefined, step([edit]), busy)).toEqual(StepTail.NO_REPEAT)
  })

  test("several calls in one step compare as an ordered group", () => {
    const read: Call = { tool: "read", input: { filePath: "a.v" }, status: "completed", result: "text" }
    const ab = step([edit, read])
    expect(StepTail.nextRepeat(ab, step([edit, read]), StepTail.NO_REPEAT)).toEqual({ calls: 1, results: 1 })
    expect(StepTail.nextRepeat(ab, step([read, edit]), { calls: 2, results: 2 })).toEqual(StepTail.NO_REPEAT)
  })
})

describe("step tail: rendering", () => {
  test("says nothing without a repeat", () => {
    expect(StepTail.renderRepeat(StepTail.NO_REPEAT)).toBeUndefined()
    expect(StepTail.render([undefined, ""])).toBeUndefined()
  })

  test("states both counters as facts", () => {
    expect(StepTail.renderRepeat({ calls: 3, results: 3 })).toBe(
      "Your last step repeated the tool calls of the step before it: 3 times in a row; the results were identical too: 3 times in a row.",
    )
    expect(StepTail.renderRepeat({ calls: 1, results: 0 })).toBe(
      "Your last step repeated the tool calls of the step before it: 1 time in a row; the results differed this time.",
    )
  })

  test("the tail message carries the marker the cache placement skips", () => {
    expect(StepTail.message("x")).toEqual({
      role: "user",
      content: [{ type: "text", text: "x" }],
      providerOptions: { opencode: { tail: true } },
    })
  })
})

// §5.3 layer 3. Seeded, so a failure names its case. The oracle recomputes both
// counters from the whole step history by their definition (fix doc §3.2); it
// shares no code with the incremental update.
function rng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function oracle(steps: StepTail.StepSignature[]): StepTail.Repeat {
  const equal = (a: readonly string[], b: readonly string[]) => JSON.stringify(a) === JSON.stringify(b)
  const trailing = (holds: (i: number) => boolean) => {
    let count = 0
    for (let i = steps.length - 1; i >= 1 && holds(i); i--) count++
    return count
  }
  const sameCalls = (i: number) => steps[i]!.calls.length > 0 && equal(steps[i]!.calls, steps[i - 1]!.calls)
  return {
    calls: trailing(sameCalls),
    results: trailing((i) => sameCalls(i) && equal(steps[i]!.results, steps[i - 1]!.results)),
  }
}

describe("step tail on random step sequences", () => {
  test("the incremental counters equal the definition at every step", () => {
    for (let n = 0; n < 300; n++) {
      const next = rng(9100 + n)
      const tools = ["edit", "read", "bash", "grep"]
      const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!
      const randomCall = (): Call => ({
        tool: pick(tools),
        input: { value: Math.floor(next() * 3) },
        status: next() < 0.5 ? "error" : "completed",
        result: `r${Math.floor(next() * 2)}`,
      })
      const steps: StepTail.StepSignature[] = []
      let repeat = StepTail.NO_REPEAT
      let previous: StepTail.StepSignature | undefined
      let calls: Call[] = []
      const length = 1 + Math.floor(next() * 25)
      for (let s = 0; s < length; s++) {
        // Bias towards repeating the previous step, with or without the same results.
        const roll = next()
        calls =
          roll < 0.45 && calls.length > 0
            ? calls.map((call) => (next() < 0.3 ? { ...call, result: `r${Math.floor(next() * 2)}` } : call))
            : roll < 0.55
              ? []
              : Array.from({ length: 1 + Math.floor(next() * 3) }, randomCall)
        const current = step(calls)
        steps.push(current)
        repeat = StepTail.nextRepeat(previous, current, repeat)
        previous = current
        expect(repeat, `seed ${9100 + n} step ${s}`).toEqual(oracle(steps))
      }
    }
  })
})
