import { raw, type Item } from "./llm-server"

export type PeriodicToolCall = {
  readonly tool: string
  readonly input: Record<string, unknown>
}

export type PeriodicToolCallChunkStyle =
  | "all-batched"
  | "one-per-chunk"
  | "pairs"
  | "fragmented-sequential"
  | "starts-then-reverse-fragments"

export type EncodedPeriodicToolCall = PeriodicToolCall & {
  readonly id: string
  readonly index: number
}

export type PeriodicToolCallFixture = {
  readonly item: Item
  readonly calls: readonly EncodedPeriodicToolCall[]
}

function chunk(delta: Record<string, unknown>, finishReason?: string) {
  return {
    id: "chatcmpl-periodic-doom-loop",
    object: "chat.completion.chunk",
    choices: [{ delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
  }
}

function completeDelta(call: EncodedPeriodicToolCall) {
  return {
    index: call.index,
    id: call.id,
    type: "function",
    function: {
      name: call.tool,
      arguments: JSON.stringify(call.input),
    },
  }
}

function startDelta(call: EncodedPeriodicToolCall) {
  return {
    index: call.index,
    id: call.id,
    type: "function",
    function: {
      name: call.tool,
      arguments: "",
    },
  }
}

function argumentsDelta(index: number, value: string) {
  return {
    index,
    function: {
      arguments: value,
    },
  }
}

function fragments(input: Record<string, unknown>) {
  const value = JSON.stringify(input)
  const first = Math.max(1, Math.floor(value.length / 3))
  const second = Math.max(first + 1, Math.floor((2 * value.length) / 3))
  return [value.slice(0, first), value.slice(first, second), value.slice(second)]
}

export function periodicToolCallResponse(input: {
  readonly blocks: readonly (readonly PeriodicToolCall[])[]
  readonly chunkStyle: PeriodicToolCallChunkStyle
  readonly idPrefix?: string
}): PeriodicToolCallFixture {
  const calls = input.blocks.flat().map((call, index) => ({
    ...call,
    id: `${input.idPrefix ?? "periodic-call"}-${index + 1}`,
    index,
  }))
  const chunks: unknown[] = [chunk({ role: "assistant" })]

  switch (input.chunkStyle) {
    case "all-batched":
      chunks.push(chunk({ tool_calls: calls.map(completeDelta) }))
      break
    case "one-per-chunk":
      for (const call of calls) {
        chunks.push(chunk({ tool_calls: [completeDelta(call)] }))
      }
      break
    case "pairs":
      for (let index = 0; index < calls.length; index += 2) {
        chunks.push(chunk({ tool_calls: calls.slice(index, index + 2).map(completeDelta) }))
      }
      break
    case "fragmented-sequential":
      for (const call of calls) {
        chunks.push(chunk({ tool_calls: [startDelta(call)] }))
        for (const value of fragments(call.input)) {
          chunks.push(chunk({ tool_calls: [argumentsDelta(call.index, value)] }))
        }
      }
      break
    case "starts-then-reverse-fragments": {
      chunks.push(chunk({ tool_calls: calls.map(startDelta) }))
      const values = calls.map((call) => ({ call, parts: fragments(call.input) }))
      const rounds = Math.max(...values.map((item) => item.parts.length))
      for (let part = 0; part < rounds; part++) {
        chunks.push(
          chunk({
            tool_calls: values
              .toReversed()
              .filter((item) => item.parts[part] !== undefined)
              .map((item) => argumentsDelta(item.call.index, item.parts[part])),
          }),
        )
      }
      break
    }
  }

  chunks.push(chunk({}, "tool_calls"))
  return {
    item: raw({ chunks }),
    calls,
  }
}
