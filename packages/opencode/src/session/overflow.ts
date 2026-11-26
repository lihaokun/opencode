import type { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  // Preflight heuristic reserve. With a known output limit the reserve keeps
  // the explicit compaction reservation ceiling; with an unknown limit the
  // bounded local buffer stands in for the missing envelope — this never goes
  // on the wire, so a bounded local constant is legitimate here.
  const reserve =
    input.cfg.compaction?.reserved ??
    (() => {
      const output = input.model.limit.output
      return output === 0 ? COMPACTION_BUFFER : Math.min(COMPACTION_BUFFER, output)
    })()

  if (input.model.limit.input) return Math.max(0, input.model.limit.input - reserve)
  // No input limit: reserve the full output envelope when known, otherwise
  // fall back to the compaction buffer (tightens the check — conservative).
  const envelope = ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax)
  return Math.max(0, context - (envelope ?? COMPACTION_BUFFER))
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}
