import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Agent } from "./agent"

/**
 * Build the `permission` ruleset for a subagent's session. Combines:
 *
 * 1. The parent session's deny rules and external_directory rules.
 *    Parent agent restrictions only govern that agent; the subagent's own
 *    permissions determine its capabilities.
 * 2. A default `todowrite` deny if the subagent's own ruleset doesn't permit it.
 *
 * Notably it does *not* deny the agent tool by default any more. Nesting depth
 * is enforced by the depth counter and by which tools the model is offered, not
 * by the ruleset — and a deny here would win, because evaluate takes the last
 * match and the session ruleset is merged after the agent definition. Emitting
 * one under the old `task` key is no better: after config normalisation nothing
 * reads that key, so the rule would be dead and an agent definition's own opt-out
 * would stop working silently.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  return [
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
