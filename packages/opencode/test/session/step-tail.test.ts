import { describe, expect, test } from "bun:test"
import { FastCheck } from "effect/testing"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { StepTail } from "../../src/session/step-tail"
import { AgentRun } from "../../src/agent-management/run"
import type { AgentManagement } from "../../src/agent-management/schema"
import { SessionID } from "../../src/session/schema"

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

// The subagent view (subplan agentmgmt-2-run-state §4.5, §5.3.1).

const now = 1_700_000_000_000
const viewer = SessionID.make("ses_viewer")
const other = SessionID.make("ses_other")
const clock = AgentRun.formatClock
const id = (n: number) => SessionID.make(`ses_${String(n).padStart(4, "0")}`)
const system = { kind: "system" as const }

function child(n: number, extra: Partial<StepTail.Child>): StepTail.Child {
  return { id: id(n), created: now - 3_600_000 + n * 1_000, running: false, ...extra }
}

function closed(number: number, endedAgo: number, outcome: AgentManagement.RunOutcome = "completed") {
  return { number, started_at: now - endedAgo - 1_000, woken_by: system, ended_at: now - endedAgo, outcome }
}

function open(number: number, startedAgo: number, woken_by: AgentManagement.WakeSource = system) {
  return { number, started_at: now - startedAgo, woken_by }
}

function view(children: StepTail.Child[], windowStart = now - StepTail.WINDOW_MS) {
  return StepTail.renderSubagents({ now, children, windowStart, viewer })
}

describe("step tail: clock and window", () => {
  test("the clock line only shows the current time", () => {
    expect(StepTail.renderClock({ now })).toBe(`Now: ${AgentRun.formatInstant(now)}.`)
  })

  test("the window reaches back ten minutes, or to the previous step's start when that is earlier", () => {
    expect(StepTail.windowStart(now, now - 1_000)).toBe(now - StepTail.WINDOW_MS)
    expect(StepTail.windowStart(now, now - 30 * 60_000)).toBe(now - 30 * 60_000)
  })
})

describe("step tail: subagent view", () => {
  test("nothing without children", () => {
    expect(view([])).toBeUndefined()
  })

  test("expired children leave the counts and finished list but preserve zero running", () => {
    const expired = Array.from({ length: 4 }, (_, i) => child(i, { run: closed(1, 120 * 60_000) }))
    expect(view(expired)).toBe("Your subagents: 0 running.")
    expect(view([...expired, child(4, {})])).toBe("Your subagents: 0 running.")
    expect(view([child(4, {})])).toBe("Your subagents: 0 running.")
    const active = child(5, { running: true, run: open(2, 1_000) })
    expect(view([...expired, active])).toBe(view([active]))
    expect(view([...expired, active])).toStartWith("Your subagents: 1 direct, 1 running, 0 idle.")
  })

  test("finished children count at the inclusive window edge, and leave it one millisecond later", () => {
    const rows = [-1, 0, 1].map((delta, i) => child(i, { run: closed(1, StepTail.WINDOW_MS + delta) }))
    const text = view(rows)!
    expect(text).toStartWith("Your subagents: 2 direct, 0 running, 2 idle.")
    expect(text).toContain(id(0))
    expect(text).toContain(id(1))
    expect(text).not.toContain(id(2))
    expect(view(rows, now - StepTail.WINDOW_MS + 1)).toStartWith("Your subagents: 1 direct, 0 running, 1 idle.")
    expect(view(rows, now - StepTail.WINDOW_MS + 2)).toBe("Your subagents: 0 running.")
  })

  test("running rows: longest-running first, with the source, the last step and the previous run inside the window", () => {
    const a = child(1, {
      running: true,
      lastStep: now - 5_000,
      name: "cw-a",
      run: {
        ...open(2, 30_000, { kind: "agent", session: viewer }),
        previous: { number: 1, ended_at: now - 60_000, outcome: "completed" },
      },
    })
    const b = child(2, {
      running: true,
      lastStep: now - 1_000,
      run: open(1, 10_000, { kind: "agent", session: other, name: "cw-b" }),
    })
    // No record yet: sorted by creation, which is long ago here.
    const c = child(3, { running: true, lastStep: now - 2_000 })
    // A closed record under a running child is the continuation window.
    const d = child(4, { running: true, lastStep: now - 3_000, run: closed(1, 4_000) })
    expect(view([b, d, a, c])).toBe(
      [
        "Your subagents: 4 direct, 4 running, 0 idle.",
        "Running now:",
        `  ${c.id}  running (run record not updated yet), last step ${clock(now - 2_000)}`,
        `  ${a.id}  cw-a  run 2 since ${clock(now - 30_000)} (your message), last step ${clock(now - 5_000)}; run 1 ended ${clock(now - 60_000)} (completed)`,
        `  ${b.id}  run 1 since ${clock(now - 10_000)} (cw-b), last step ${clock(now - 1_000)}`,
        `  ${d.id}  running (run record not updated yet), last step ${clock(now - 3_000)}`,
      ].join("\n"),
    )
  })

  test("the previous run is left out when it ended before the window", () => {
    const a = child(1, {
      running: true,
      lastStep: now,
      run: { ...open(2, 30_000), previous: { number: 1, ended_at: now - 20 * 60_000, outcome: "failed" } },
    })
    expect(view([a])).toBe(
      [
        "Your subagents: 1 direct, 1 running, 0 idle.",
        "Running now:",
        `  ${a.id}  run 2 since ${clock(now - 30_000)} (system), last step ${clock(now)}`,
      ].join("\n"),
    )
  })

  test("finished rows: newest first, the four outcomes, and a cut-off run whatever the window", () => {
    const rows = [
      child(1, { run: closed(3, 60_000, "stopped") }),
      child(2, { run: closed(1, 30_000, "failed") }),
      child(3, { run: closed(2, 120_000, "lost") }),
      child(4, { run: closed(5, 20 * 60_000, "completed") }),
      child(5, { name: "cw-e", run: open(4, 25 * 60_000) }),
    ]
    expect(view(rows)).toBe(
      [
        "Your subagents: 4 direct, 0 running, 4 idle.",
        "Finished in the last 10 minutes, now idle:",
        `  ${id(2)}  run 1 ended ${clock(now - 30_000)} (failed)`,
        `  ${id(1)}  run 3 ended ${clock(now - 60_000)} (stopped)`,
        `  ${id(3)}  run 2 ended ${clock(now - 120_000)} (lost)`,
        `  ${id(5)}  cw-e  run 4 cut off since ${clock(now - 25 * 60_000)} (not yet recorded as lost)`,
      ].join("\n"),
    )
  })

  test("the heading names the window's start when it reaches past ten minutes", () => {
    const start = now - 30 * 60_000
    expect(view([child(1, { run: closed(1, 15 * 60_000) })], start)).toBe(
      [
        "Your subagents: 1 direct, 0 running, 1 idle.",
        `Finished since ${clock(start)}, now idle:`,
        `  ${id(1)}  run 1 ended ${clock(now - 15 * 60_000)} (completed)`,
      ].join("\n"),
    )
  })

  test("past ten of either, the newest running and the oldest finished are counted, not listed", () => {
    const running = Array.from({ length: 12 }, (_, i) => child(i + 1, { running: true, run: open(1, (i + 1) * 1_000) }))
    const finished = Array.from({ length: 12 }, (_, i) => child(i + 20, { run: closed(1, (i + 1) * 1_000) }))
    const lines = view([...running, ...finished])!.split("\n")
    expect(lines[0]).toBe("Your subagents: 24 direct, 12 running, 12 idle.")
    expect(lines.slice(1, 13)).toEqual([
      "Running now:",
      ...running
        .slice(2)
        .reverse()
        .map((row) => `  ${row.id}  run 1 since ${clock(row.run!.started_at)} (system)`),
      "  … and 2 more running",
    ])
    expect(lines.slice(13)).toEqual([
      "Finished in the last 10 minutes, now idle:",
      ...finished.slice(0, 10).map((row) => `  ${row.id}  run 1 ended ${clock(row.run!.ended_at!)} (completed)`),
      "  … and 2 more finished",
    ])
    expect(lines).toHaveLength(25)
  })

  test("a name is escaped, so a row stays one line — the wake source's name too", () => {
    const text = view([child(1, { name: "a]\nb", run: closed(1, 1_000) })])!
    expect(text.split("\n")).toHaveLength(3)
    expect(text).toContain(`  ${id(1)}  a\\]\\nb  run 1 ended`)
    const forged = view([
      child(2, { running: true, run: open(1, 1_000, { kind: "agent", session: other, name: "cw]\nstatus: idle" }) }),
    ])!
    expect(forged.split("\n")).toHaveLength(3)
    expect(forged).toContain("(cw\\]\\nstatus: idle)")
  })

  // T7 (INV-8b): random children and windows against the definition. The
  // running list is the running children by start (or creation) ascending,
  // the finished list the idle children whose record is open or ended inside
  // the window, by end (or start) descending; ten rows each, the rest counted.
  test("T7: random children and windows match the definition", () => {
    const outcomes: AgentManagement.RunOutcome[] = ["completed", "failed", "stopped", "lost"]
    for (let n = 0; n < 12; n++) {
      const next = rng(9500 + n)
      const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!
      const count = Math.floor(next() * 41)
      const children = Array.from({ length: count }, (_, i) => {
        const running = next() < 0.4
        const roll = next()
        const started_at = now - Math.floor(next() * 3_600_000)
        const number = 1 + Math.floor(next() * 5)
        // Wake sources with names, some of them hostile: a row must stay one line.
        const woken_by: AgentManagement.WakeSource =
          next() < 0.5 ? system : { kind: "agent", session: other, name: pick(["peer", "a]\nb", "t\tx", "[x]"]) }
        const run =
          roll < 0.2
            ? undefined
            : roll < 0.4
              ? { number, started_at, woken_by }
              : {
                  number,
                  started_at,
                  woken_by,
                  ended_at: started_at + Math.floor(next() * (now - started_at)),
                  outcome: outcomes[Math.floor(next() * 4)]!,
                }
        const previous =
          run && run.number > 1 && next() < 0.3
            ? {
                number: run.number - 1,
                ended_at: now - Math.floor(next() * 20 * 60_000),
                outcome: "completed" as const,
              }
            : undefined
        return child(i, {
          running,
          ...(running ? { lastStep: now - Math.floor(next() * 60_000) } : {}),
          ...(next() < 0.5 ? { name: `n${i}` } : {}),
          ...(run ? { run: { ...run, ...(previous ? { previous } : {}) } } : {}),
        })
      })
      const windowStart =
        next() < 0.5 ? now - StepTail.WINDOW_MS : now - StepTail.WINDOW_MS - Math.floor(next() * 50 * 60_000)
      const text = StepTail.renderSubagents({ now, children, windowStart, viewer })
      const label = `seed ${9500 + n}`
      const start = (row: StepTail.Child) => row.run?.started_at ?? row.created
      const end = (row: StepTail.Child) => row.run?.ended_at ?? row.run?.started_at ?? 0
      const byId = (a: StepTail.Child, b: StepTail.Child) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      const running = children.filter((row) => row.running).toSorted((a, b) => start(a) - start(b) || byId(a, b))
      const finished = children
        .filter((row) => !row.running && row.run && (row.run.ended_at === undefined || row.run.ended_at >= windowStart))
        .toSorted((a, b) => end(b) - end(a) || byId(a, b))

      if (running.length + finished.length === 0) {
        expect(text, label).toBe(children.length === 0 ? undefined : "Your subagents: 0 running.")
        continue
      }

      const lines = text!.split("\n")
      expect(lines[0], label).toBe(
        `Your subagents: ${running.length + finished.length} direct, ${running.length} running, ${finished.length} idle.`,
      )
      const runningAt = lines.indexOf("Running now:")
      const finishedAt = lines.findIndex((line) => line.startsWith("Finished "))
      const ids = (from: number, until: number) =>
        lines
          .slice(from, until)
          .filter((line) => line.startsWith("  ses_"))
          .map((line) => line.trim().split("  ")[0])
      expect(runningAt === -1 ? [] : ids(runningAt + 1, finishedAt === -1 ? lines.length : finishedAt), label).toEqual(
        running.slice(0, StepTail.LIST_ROWS).map((row) => row.id),
      )
      expect(finishedAt === -1 ? [] : ids(finishedAt + 1, lines.length), label).toEqual(
        finished.slice(0, StepTail.LIST_ROWS).map((row) => row.id),
      )
      expect(
        lines.find((line) => line.endsWith("more running")),
        label,
      ).toBe(
        running.length > StepTail.LIST_ROWS ? `  … and ${running.length - StepTail.LIST_ROWS} more running` : undefined,
      )
      expect(
        lines.find((line) => line.endsWith("more finished")),
        label,
      ).toBe(
        finished.length > StepTail.LIST_ROWS
          ? `  … and ${finished.length - StepTail.LIST_ROWS} more finished`
          : undefined,
      )
      // Exactly one line per row and heading: no name forged a line of its own.
      const shownRunning = Math.min(running.length, StepTail.LIST_ROWS)
      const shownFinished = Math.min(finished.length, StepTail.LIST_ROWS)
      expect(lines.length, label).toBe(
        1 +
          (running.length > 0 ? 1 + shownRunning + (running.length > StepTail.LIST_ROWS ? 1 : 0) : 0) +
          (finished.length > 0 ? 1 + shownFinished + (finished.length > StepTail.LIST_ROWS ? 1 : 0) : 0),
      )
      expect(lines.length, label).toBeLessThanOrEqual(25)
      expect(StepTail.renderSubagents({ now, children, windowStart, viewer }), label).toBe(text)
    }
  })

  test("PBT: overview counts ignore expired history while known children preserve zero running", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.integer({ min: 0, max: 50 * 60_000 }),
        FastCheck.array(
          FastCheck.record({
            kind: FastCheck.constantFrom(
              "running",
              "running-unrecorded",
              "running-closed",
              "recent",
              "expired",
              "cut-off",
              "unrecorded",
            ),
            age: FastCheck.integer({ min: 0, max: 3_600_000 }),
            outcome: FastCheck.constantFrom<AgentManagement.RunOutcome>("completed", "failed", "stopped", "lost"),
          }),
          { maxLength: 60 },
        ),
        FastCheck.array(FastCheck.integer({ min: 1, max: 3_600_000 }), { maxLength: 20 }),
        (extension, cases, ages) => {
          const width = StepTail.WINDOW_MS + extension
          const children = cases.map((item, i) => {
            const running = item.kind.startsWith("running")
            const run =
              item.kind === "unrecorded" || item.kind === "running-unrecorded"
                ? undefined
                : item.kind === "running" || item.kind === "cut-off"
                  ? open(2, width + item.age + 1)
                  : closed(2, item.kind === "recent" ? item.age % (width + 1) : width + item.age + 1, item.outcome)
            return child(i, { running, ...(run ? { run } : {}) })
          })
          // The oracle uses generated lifecycle classes, not the production
          // timestamp predicate. Counts cover the whole sets before truncation.
          const running = cases.filter((item) => item.kind.startsWith("running")).length
          const idle = cases.filter((item) => item.kind === "recent" || item.kind === "cut-off").length
          const before = structuredClone(children)
          const text = view(children, now - width)
          expect(text?.split("\n")[0]).toBe(
            running + idle === 0
              ? children.length === 0
                ? undefined
                : "Your subagents: 0 running."
              : `Your subagents: ${running + idle} direct, ${running} running, ${idle} idle.`,
          )
          const history = ages.flatMap((age, i) => [
            child(1000 + i, { run: closed(1, width + age) }),
            child(2000 + i, {}),
          ])
          expect(view([...history, ...children], now - width)).toBe(
            children.length === 0 && history.length > 0 ? "Your subagents: 0 running." : text,
          )
          expect(children).toEqual(before)
        },
      ),
      { numRuns: 200, seed: 97103 },
    )
  })

  test("PBT: advancing past expiry drops closed runs while running and cut-off rows remain", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.integer({ min: 0, max: 3_600_000 }),
        FastCheck.constantFrom<AgentManagement.RunOutcome>("completed", "failed", "stopped", "lost"),
        (age, outcome) => {
          const ended = child(1, { run: closed(1, age, outcome) })
          const persistent = [
            child(2, { running: true, run: open(2, age + 1_000) }),
            child(3, { run: open(1, age + 2_000) }),
          ]
          const at = now - age + StepTail.WINDOW_MS
          const render = (time: number, children: StepTail.Child[]) =>
            StepTail.renderSubagents({ now: time, children, windowStart: time - StepTail.WINDOW_MS, viewer })
          expect(render(at, [ended, ...persistent])).toStartWith("Your subagents: 3 direct, 1 running, 2 idle.")
          expect(render(at + 1, [ended, ...persistent])).toBe(render(at + 1, persistent))
          expect(render(at + 1, persistent)).toStartWith("Your subagents: 2 direct, 1 running, 1 idle.")
          expect(render(at + 1, [ended])).toBe("Your subagents: 0 running.")
        },
      ),
      { numRuns: 100, seed: 97104 },
    )
  })
})
