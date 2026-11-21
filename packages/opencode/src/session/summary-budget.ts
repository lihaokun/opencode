import { asSchema, type ModelMessage } from "ai"
import type { LLMRequestPrep } from "./llm/request"

const tokens = (chars: number) => Math.ceil(chars / 3)

// Message framing and provider-specific encodings remain approximate. Use the
// same projection on both sides of the usage delta.
export function estimateMessages(messages: readonly ModelMessage[]) {
  return messages.reduce((sum, message) => {
    if (typeof message.content === "string") return sum + tokens(message.content.length)
    return (
      sum +
      tokens(
        message.content.reduce((length, part) => {
          if (part.type === "text" || part.type === "reasoning") return length + part.text.length
          if (part.type === "tool-call")
            return length + part.toolName.length + (JSON.stringify(part.input)?.length ?? 0)
          if (part.type === "tool-result") return length + part.toolName.length + JSON.stringify(part.output).length
          return length + JSON.stringify(part).length
        }, 0),
      )
    )
  }, 0)
}

export async function estimatePayload(payload: LLMRequestPrep.PreparedPayload) {
  const schemas = await Promise.all(
    Object.entries(payload.tools).map(async ([name, tool]) =>
      tokens(
        name.length +
          (tool.description?.length ?? 0) +
          JSON.stringify(await asSchema(tool.inputSchema).jsonSchema).length,
      ),
    ),
  )
  return (
    payload.system.reduce((sum, text) => sum + tokens(text.length), estimateMessages(payload.messages)) +
    schemas.reduce((sum, item) => sum + item, 0)
  )
}

export function calibratedInput(current: number, baseline?: { actual: number; estimate: number }) {
  return Math.max(0, current + (baseline ? baseline.actual - baseline.estimate : 0))
}

export function providerGap(message: string) {
  const direct = /([\d,]+)\s*tokens?\s*>\s*([\d,]+)/i.exec(message)
  const total =
    /maximum context length (?:of|is)\s*([\d,]+)\s*tokens?[^\n]{0,200}?requested (?:a total of )?([\d,]+)\s*tokens?/i.exec(
      message,
    )
  const pair = direct ? [direct[1], direct[2]] : total ? [total[2], total[1]] : undefined
  if (!pair) return
  const [actual, limit] = pair.map((n) => Number(n?.replaceAll(",", "")))
  if (Number.isSafeInteger(actual) && Number.isSafeInteger(limit) && actual! > limit! && limit! > 0)
    return actual! - limit!
}

export function firstStage(gap: number, budget: number) {
  return Math.max(5, Math.min(25, 5 * Math.ceil((gap * 20) / budget)))
}

// A single original prefix defines every stage. The caller reports the measured
// reduction only after sending a prepared candidate; otherwise keep the stage.
export function* recoveryBoundaries(
  budget: number,
  gap: number,
  groups: readonly { start: number; reduction: number }[],
): Generator<{ start: number; target: number }, void, number | undefined> {
  let stage = firstStage(gap, budget)
  for (const [index, group] of groups.entries()) {
    if (stage > 25) return
    const target = Math.ceil((budget * stage) / 100)
    if (group.reduction < target && index !== groups.length - 1) continue
    const actual = yield { start: group.start, target }
    if (actual === undefined) continue
    while (stage <= 25 && actual >= Math.ceil((budget * stage) / 100)) stage += 5
  }
}
