import { Effect } from "effect"
import type { BackgroundJob } from "@/background/job"
import type { SessionID } from "@/session/schema"

// Live registry of background shell tasks, keyed by task id. Kept in its own
// module so the cancel cascades (run-state.ts, session.ts) can read the
// cancel snapshot without importing tool/shell.ts — that import is a module
// cycle: session → tool/shell → plugin → session, which deadlocks the
// provider LayerNode's `deps` array at module-init time (ReferenceError:
// Cannot access 'node' before initialization, caught by CI's generate step).
//
// Process-local and intentionally non-durable, mirroring the BackgroundJob
// registry semantics: a restart loses both the process and its buffer.
// Entries are removed once the run settles — the bounded status+output snapshot
// stays on the BackgroundJob record and completion message, and an entry left
// behind would accumulate one per background call for the life of the process.
export type ShellTaskEntry = {
  command: string
  sessionID: SessionID
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

/**
 * Shared one-pass background-job cancel cascade for a session tree: discovers
 * descendant agent owners from BackgroundJob metadata, appends newly discovered
 * ids into `owners`, and cancels every running job owned by the tree while
 * preserving live shell output buffers via `cancelSnapshot`.
 */
export const cancelBackgroundJobsPass = Effect.fn("ShellTasks.cancelBackgroundJobsPass")(function* (
  background: BackgroundJob.Interface,
  owners: Set<string>,
) {
  const all = yield* background.list()
  const children = new Map<string, string[]>()
  for (const job of all) {
    const parent = job.metadata?.parentSessionId
    if (job.type !== "agent" || typeof parent !== "string") continue
    const child = typeof job.metadata?.sessionId === "string" ? job.metadata.sessionId : job.id
    const siblings = children.get(parent)
    if (!siblings) {
      children.set(parent, [child])
      continue
    }
    siblings.push(child)
  }
  // A delegation can have finished while its shell is live. Set iteration
  // visits newly added descendants and terminates even if an edge repeats.
  for (const owner of owners) {
    for (const child of children.get(owner) ?? []) owners.add(child)
  }
  const jobs = all.filter((job) => {
    if (job.status !== "running") return false
    if (owners.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && owners.has(job.metadata.sessionId)) return true
    return typeof job.metadata?.parentSessionId === "string" && owners.has(job.metadata.parentSessionId)
  })
  yield* Effect.forEach(
    jobs,
    (job) => {
      owners.add(job.id)
      if (typeof job.metadata?.sessionId === "string") owners.add(job.metadata.sessionId)
      // The interrupted shell cannot settle its own output.
      return background.cancel(job.id, { output: cancelSnapshot(job.id) })
    },
    { concurrency: "unbounded", discard: true },
  )
  return jobs.length
})
