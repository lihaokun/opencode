import { Cause, Effect, Exit, Path } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Worktree } from "../worktree"
import { AgentManagement } from "./schema"

/** Everything this feature creates lives here, flat, inside the project. */
export const WORKTREE_ROOT = ".opencode/worktrees"

/**
 * Placement is forced rather than chosen. Subagents do not switch instances, and
 * containsPath only looks at the instance directory and the worktree — not at
 * the project's sandbox list — so a workspace under the global data directory
 * would prompt for external_directory on every file it touched.
 *
 * Flat rather than nested: a workspace inside its creator's would be deleted
 * along with it.
 */
export const prepareWorkdir = Effect.fn("AgentWorkdir.prepare")(function* (input: {
  cwd?: string
  parentWorkdir?: AgentManagement.AgentWorkdir
}) {
  const ctx = yield* InstanceState.context
  const pathSvc = yield* Path.Path
  const fs = yield* FSUtil.Service

  // A model-supplied path gets no automatic permission grant: doing so would let
  // a model hand itself `agent(cwd: <anywhere>)` as a way around
  // external_directory. Outside the instance it prompts on first use, as usual.
  if (input.cwd) {
    return { path: input.cwd, source: "provided_cwd" as const }
  }

  const destinationRoot = pathSvc.join(ctx.directory, WORKTREE_ROOT)

  if (ctx.project.vcs !== "git") {
    // Entirely new ground: the worktree service refuses non-git outright, so
    // there is nothing to reuse. An empty directory, and the Agent is told where
    // the source is and left to copy what it needs.
    const directory = pathSvc.join(destinationRoot, `agent-${Date.now().toString(36)}`)
    const made = yield* fs.ensureDir(directory).pipe(Effect.exit)
    if (Exit.isFailure(made)) {
      return yield* new AgentManagement.WorktreeUnavailable({
        reason: `could not create a workspace directory: ${Cause.pretty(made.cause)}`,
        paths: [directory],
      })
    }
    return { path: directory, source: "generated_empty_workspace" as const }
  }

  yield* registerIgnore(ctx.worktree)

  const baseDirectory = input.parentWorkdir?.path ?? ctx.directory
  const head = yield* runGit(["rev-parse", "HEAD"], baseDirectory)
  if (head.code !== 0) {
    return yield* new AgentManagement.WorktreeUnavailable({
      reason: `could not read HEAD of ${baseDirectory}: ${head.stderr || head.text}`,
      paths: [],
    })
  }

  const worktree = yield* Worktree.Service
  const created = yield* worktree
    .createForAgent({ destinationRoot, baseCommit: head.text.trim() })
    .pipe(Effect.exit)
  if (Exit.isFailure(created)) {
    // Only promises no Session, no prompt and no Agent. Anything already written
    // to info/exclude, and any directory or branch created on the way, may
    // survive; the paths go back with the error for a human to deal with.
    return yield* new AgentManagement.WorktreeUnavailable({
      reason: Cause.pretty(created.cause),
      paths: [destinationRoot],
    })
  }

  return { path: created.value.directory, source: "generated_git_worktree" as const }
})

/**
 * Registers the workspace root in `.git/info/exclude` rather than writing a
 * .gitignore into the user's tree. It is repo-local, never committed, invisible
 * to `git status`, lives in the common dir so one entry covers every linked
 * worktree, and ripgrep honours it — which is what keeps glob and grep from
 * finding a copy of every file in every workspace.
 *
 * Not via Snapshot's `sync`: that rewrites the file from its own block list.
 */
const registerIgnore = Effect.fn("AgentWorkdir.registerIgnore")(function* (worktreeDir: string) {
  const fs = yield* FSUtil.Service
  const located = yield* runGit(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], worktreeDir)
  if (located.code !== 0) return
  const file = located.text.trim()
  if (!file) return

  const entry = `/${WORKTREE_ROOT}`
  const existing = (yield* fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))) ?? ""
  if (existing.split("\n").some((line) => line.trim() === entry)) return

  const next = existing.trimEnd()
  yield* fs
    .writeFileString(file, next ? `${next}\n${entry}\n` : `${entry}\n`)
    .pipe(Effect.catch(() => Effect.void))
})

const runGit = Effect.fn("AgentWorkdir.git")(function* (args: string[], cwd: string) {
  const appProcess = yield* AppProcess.Service
  return yield* appProcess
    .run(ChildProcess.make("git", args, { cwd, extendEnv: true, stdin: "ignore" }))
    .pipe(
      Effect.map((result) => ({
        code: result.exitCode,
        text: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8"),
      })),
      Effect.catch(() => Effect.succeed({ code: 1, text: "", stderr: "git invocation failed" })),
    )
})

export * as AgentWorkdir from "./workdir"
