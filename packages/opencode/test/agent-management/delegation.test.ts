import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { AgentDelegation } from "@/agent-management/delegation"
import { SessionID } from "@/session/schema"

const sessionID = SessionID.make("ses_child")
const limits = { maxLines: 20, maxBytes: 2000 }

function result(input: {
  role?: "assistant" | "user"
  finish?: string
  error?: { name: string; data?: Record<string, unknown> }
  parts?: SessionV1.Part[]
  tokens?: { output: number; reasoning: number }
}): SessionV1.WithParts {
  return {
    info: {
      role: input.role ?? "assistant",
      id: "msg",
      sessionID,
      finish: input.finish,
      error: input.error,
      tokens: {
        input: 0,
        output: input.tokens?.output ?? 0,
        reasoning: input.tokens?.reasoning ?? 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts: input.parts ?? [],
  } as unknown as SessionV1.WithParts
}

const text = (value: string) => ({ type: "text", text: value }) as unknown as SessionV1.Part
const toolPart = (state: Record<string, unknown>) => ({ type: "tool", state }) as unknown as SessionV1.Part

describe("classify", () => {
  test("a non-assistant result is a protocol failure", () => {
    const outcome = AgentDelegation.classify(result({ role: "user" }), sessionID, limits)
    expect(outcome.kind).toBe("failed")
    expect(outcome.kind === "failed" && outcome.text).toContain("non-assistant")
  })

  // Order matters here: an abort is also an error, so checking for a general
  // error first would report a cancellation as a failure and settle the job as
  // `error` rather than `cancelled`.
  test("an abort is a cancellation, even though it is also an error", () => {
    const outcome = AgentDelegation.classify(
      result({ error: { name: "MessageAbortedError" }, finish: "length" }),
      sessionID,
      limits,
    )
    expect(outcome.kind).toBe("cancelled")
  })

  test("an error becomes a failure carrying its name", () => {
    const outcome = AgentDelegation.classify(
      result({ error: { name: "ProviderError", data: { message: "upstream exploded" } } }),
      sessionID,
      limits,
    )
    expect(outcome.kind).toBe("failed")
    expect(outcome.kind === "failed" && outcome.text).toContain("ProviderError")
    expect(outcome.kind === "failed" && outcome.text).toContain("upstream exploded")
  })

  test("running out of output length reports the token counts", () => {
    const outcome = AgentDelegation.classify(
      result({ finish: "length", parts: [text("partial work")], tokens: { output: 6, reasoning: 31994 } }),
      sessionID,
      limits,
    )
    expect(outcome.kind).toBe("failed")
    expect(outcome.kind === "failed" && outcome.text).toContain("reasoning_tokens=31994")
    expect(outcome.kind === "failed" && outcome.text).toContain("partial work")
  })

  test("a failed tool call surfaces that tool's error", () => {
    const outcome = AgentDelegation.classify(
      result({ finish: "stop", parts: [toolPart({ status: "error", error: "rg exited 2" })] }),
      sessionID,
      limits,
    )
    expect(outcome.kind).toBe("failed")
    expect(outcome.kind === "failed" && outcome.text).toContain("rg exited 2")
  })

  test("an unknown finish with nothing usable is incomplete", () => {
    const outcome = AgentDelegation.classify(result({ finish: "unknown" }), sessionID, limits)
    expect(outcome.kind).toBe("failed")
    expect(outcome.kind === "failed" && outcome.text).toContain("IncompleteResponse")
  })

  test("a missing finish with usable output is not incomplete", () => {
    const outcome = AgentDelegation.classify(result({ parts: [text("the answer")] }), sessionID, limits)
    expect(outcome.kind).toBe("completed")
  })

  test("the result is the last text part, not every part joined", () => {
    const outcome = AgentDelegation.classify(
      result({ finish: "stop", parts: [text("thinking out loud"), text("the answer")] }),
      sessionID,
      limits,
    )
    expect(outcome.kind === "completed" && outcome.text).toBe("the answer")
  })

  // A run that ends in tool calls legitimately produces no prose. That is a
  // completed delegation with nothing to say, not a failure, and inventing
  // filler would render a normal outcome as a problem.
  test("a completed run may carry no text at all", () => {
    const outcome = AgentDelegation.classify(
      result({ finish: "stop", parts: [toolPart({ status: "completed" })] }),
      sessionID,
      limits,
    )
    expect(outcome.kind).toBe("completed")
    expect(outcome.kind === "completed" && outcome.text).toBe("")
  })
})

describe("toExit", () => {
  // The job's settled status is derived from the run's exit, so these have to be
  // three different exits — returning a tagged value on the success channel
  // would settle every job as completed.
  test("completed succeeds with its text", async () => {
    const { Effect } = await import("effect")
    expect(await Effect.runPromise(AgentDelegation.toExit({ kind: "completed", text: "done" }))).toBe("done")
  })

  test("failed takes the error channel", async () => {
    const { Effect, Exit } = await import("effect")
    const exit = await Effect.runPromise(Effect.exit(AgentDelegation.toExit({ kind: "failed", text: "nope" })))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test("cancelled interrupts rather than failing", async () => {
    const { Cause, Effect, Exit } = await import("effect")
    const exit = await Effect.runPromise(Effect.exit(AgentDelegation.toExit({ kind: "cancelled" })))
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  })
})
