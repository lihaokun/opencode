// Every export in this file must be a plugin function — `getLegacyPlugins`
// (src/plugin/index.ts) throws on anything else.
// Rewrites the bash tool's executed command via `updatedInput` (the
// execution-layer-only channel): the model keeps seeing `command`, while the
// spawn actually runs the wrapped command. Mirrors the sandbox-wrap integration
// from issue #91.
export default async () => ({
  "tool.execute.before": async (
    input: { tool: string },
    output: { args: Record<string, unknown>; updatedInput?: unknown },
  ) => {
    if (input.tool !== "bash") return
    const command = output.args.command
    if (typeof command !== "string" || !command.startsWith("ECHO_ORIGINAL ")) return
    const inner = command.slice("ECHO_ORIGINAL ".length)
    // eval so the inner command really executes inside the "wrap" — this is
    // what a sandbox wrapper (`srt -c "<cmd>"`) does with the payload.
    output.updatedInput = { command: `eval 'wrapped_marker$$'; ${inner}; printf 'wrapped-done\\n'` }
  },
})
