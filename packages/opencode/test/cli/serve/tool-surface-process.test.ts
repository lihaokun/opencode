// End-to-end regression for issue #74: the model-visible tool surface must
// not depend on the model ID. The registry used to swap write/edit out for
// apply_patch whenever the model ID contained "gpt-", which broke path-gated
// integrations built on the (tool, filePath) contract.
//
// This tier drives a real `opencode serve` subprocess with a GPT-named model
// (ID deliberately contains "gpt-" but nothing else OpenAI-specific) and
// asserts the HTTP tool listing exposes write/edit and never apply_patch —
// the same contract the unit-level registry test pins, but through the
// spawned-server path (#74's actual entry point: GET /experimental/tool).
import { describe, expect } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { testProviderConfig } from "../../lib/test-provider"

const SERVER_READY_TIMEOUT_MS = 45_000

type Sdk = ReturnType<typeof createOpencodeClient>

function call<T>(request: () => Promise<T>, label: string) {
  return Effect.promise(request).pipe(
    Effect.timeoutOrElse({
      duration: "45 seconds",
      orElse: () => Effect.fail(new Error(`timed out waiting for ${label}`)),
    }),
  )
}

describe("model-conditional tool surface (issue #74, spawned server)", () => {
  cliIt.live(
    "gpt-named model sees write/edit and never apply_patch over the tool API",
    (test) =>
      Effect.gen(function* () {
        // A model ID that hits the old usePatch predicate ("gpt-" prefix, no
        // "oss"/"gpt-4") served by the isolated test provider, so no real
        // OpenAI credential is involved.
        const config = testProviderConfig(test.llm.url)
        const gptModels = (config.provider.test.models ?? {}) as Record<string, unknown>
        gptModels["gpt-6-luna"] = {
          ...(gptModels["test-model"] as Record<string, unknown>),
          id: "gpt-6-luna",
          name: "Test Model (gpt-6-luna)",
        }

        const server = yield* test.opencode.serve({
          readyTimeoutMs: SERVER_READY_TIMEOUT_MS,
          env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, provider: { ...config.provider, test: { ...config.provider.test, models: gptModels } } }) },
        })
        const sdk = createOpencodeClient({ baseUrl: server.url, directory: test.home })

        const listed = yield* call(
          () => sdk.tool.list({ directory: test.home, provider: "test", model: "gpt-6-luna" }),
          "tool listing",
        )
        const ids = (listed.data as Array<{ id: string }>).map((tool) => tool.id)

        expect(ids).toContain("write")
        expect(ids).toContain("edit")
        expect(ids).not.toContain("apply_patch")
      }),
    120_000,
  )
})
