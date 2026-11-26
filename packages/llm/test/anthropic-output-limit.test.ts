import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, Message } from "../src"
import { Auth, LLMClient } from "../src/route"
import * as AnthropicMessages from "../src/protocols/anthropic-messages"
import type { AnthropicMessagesBody } from "../src/protocols/anthropic-messages"
import { it } from "./lib/effect"

// Anthropic Messages requires max_tokens on every request. When opencode's
// native path hands down an unknown output limit (0, the "no metadata" shape
// from opencode#98), the protocol must fall back to its declared adapter
// default (4096) — `?? 4096` alone does not fire because 0 is not nullish.
// Provider facades pass limits as a top-level route.with field, which lands
// in route.defaults.limits (client.ts destructures the patch rest).
const anthropicRoute = (limitsOutput: number | undefined) =>
  AnthropicMessages.route.with({
    endpoint: { baseURL: "https://api.anthropic.test/v1/" },
    auth: Auth.header("x-api-key", "test"),
    ...(limitsOutput === undefined ? {} : { limits: { output: limitsOutput } }),
  })

describe("AnthropicMessages output limit fallback", () => {
  it.effect("omitted maxTokens with limits.output = 0 sends 4096, not 0 (#98)", () =>
    Effect.gen(function* () {
      const model = anthropicRoute(0).model({ id: "custom-anthropic-model" })
      const prepared = yield* LLMClient.prepare<AnthropicMessagesBody>(
        LLM.request({
          model,
          system: "You are concise.",
          messages: [Message.user("hi")],
        }),
      )
      expect(prepared.body.max_tokens).toBe(4096)
    }),
  )

  it.effect("omitted maxTokens without limits still sends 4096", () =>
    Effect.gen(function* () {
      const model = anthropicRoute(undefined).model({ id: "custom-anthropic-model" })
      const prepared = yield* LLMClient.prepare<AnthropicMessagesBody>(
        LLM.request({
          model,
          system: "You are concise.",
          messages: [Message.user("hi")],
        }),
      )
      expect(prepared.body.max_tokens).toBe(4096)
    }),
  )

  it.effect("explicit generation maxTokens wins over the fallback", () =>
    Effect.gen(function* () {
      const model = anthropicRoute(0).model({ id: "custom-anthropic-model" })
      const prepared = yield* LLMClient.prepare<AnthropicMessagesBody>(
        LLM.request({
          model,
          system: "You are concise.",
          messages: [Message.user("hi")],
          generation: { maxTokens: 8_192 },
        }),
      )
      expect(prepared.body.max_tokens).toBe(8_192)
    }),
  )
})
