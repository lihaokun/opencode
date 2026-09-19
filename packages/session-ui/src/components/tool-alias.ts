/**
 * Other names a tool answers to, mapped onto the one its component is
 * registered under.
 *
 * `task` is what the agent tool was called before the rename. Sessions recorded
 * then still hold parts under that name, and a transcript that predates a
 * rename should not degrade into unknown-tool cards.
 *
 * Its own module so it can be tested without pulling in message-part.tsx, which
 * imports a Vite worker.
 */
export const TOOL_ALIASES: Record<string, string> = {
  apply_patch: "patch",
  bash: "shell",
  task: "agent",
}

export function resolveToolName(name: string) {
  return TOOL_ALIASES[name] ?? name
}

/** Whether a part belongs to the agent tool, under either of its names. */
export function isAgentTool(name: string | undefined) {
  return name !== undefined && resolveToolName(name) === "agent"
}
