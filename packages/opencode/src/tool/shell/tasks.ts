// Live registry of background shell tasks, keyed by task id. Kept in its own
// module so the cancel cascades (run-state.ts, session.ts) can read the
// cancel snapshot without importing tool/shell.ts — that import is a module
// cycle: session → tool/shell → plugin → session, which deadlocks the
// provider LayerNode's `deps` array at module-init time (ReferenceError:
// Cannot access 'node' before initialization, caught by CI's generate step).
//
// Process-local and intentionally non-durable, mirroring the BackgroundJob
// registry semantics: a restart loses both the process and its buffer.
// Entries are removed once the run settles — output lives with the tool
// parts from then on, and an entry left behind would accumulate one per
// background call for the life of the process.
export type ShellTaskEntry = {
  command: string
  sessionID: import("../../session/schema").SessionID
  buffer: string
  exit: number | undefined
  error: string | undefined
  startedAt: number
}

export const shellTasks = new Map<string, ShellTaskEntry>()

/**
 * Cancel snapshot for a live shell task: what BackgroundJob.cancel should
 * persist when the run is interrupted. The interrupted fiber never reaches
 * its settle, so without this snapshot the accumulated buffer is lost. Same
 * `status\nbuffer` shape the natural settle produces, which is what lets
 * shell_output's post-settle read report the real status. Undefined for a
 * task this process no longer owns (settled, foreign, or post-restart).
 */
export function cancelSnapshot(taskId: string): string | undefined {
  const entry = shellTasks.get(taskId)
  if (!entry) return undefined
  return `stopped\n${entry.buffer}`
}
