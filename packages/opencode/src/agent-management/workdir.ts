import { Cause, Effect, Exit, Option, Path } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import * as Identifier from "@opencode-ai/core/id/id"
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
    // Resolved and normalised before it is stored. The value goes into the
    // session's metadata and is read back later, so a relative path would mean
    // whatever the reader's process directory happened to be at the time —
    // the same workspace landing in different places on different reads.
    return { path: pathSvc.resolve(ctx.directory, input.cwd), source: "provided_cwd" as const }
  }

  const destinationRoot = pathSvc.join(ctx.directory, WORKTREE_ROOT)

  // An empty directory, with the Agent told where the source is and left to
  // copy what it needs. Reached both when the project is not a git repository
  // at all and when git declines to give a worktree for one that is.
  //
  // A monotonic unique id, not a timestamp: two workspaces created in the same
  // millisecond would land on the same directory. Slug.create is no use here
  // either — 29 adjectives by 31 nouns is 899 combinations, so it collides at
  // even odds by the 35th directory. It is a display name, not an identifier.
  const emptyWorkspace = Effect.fn("AgentWorkdir.emptyWorkspace")(function* (note?: string) {
    const directory = pathSvc.join(destinationRoot, Identifier.create("agent", "ascending"))
    const made = yield* fs.ensureDir(directory).pipe(Effect.exit)
    if (Exit.isFailure(made)) {
      return yield* new AgentManagement.WorktreeUnavailable({
        reason: `could not create a workspace directory: ${Cause.pretty(made.cause)}`,
        paths: [directory],
      })
    }
    return { path: directory, source: "generated_empty_workspace" as const, ...(note ? { note } : {}) }
  })

  // The worktree service refuses non-git outright, so there is nothing to reuse.
  if (ctx.project.vcs !== "git") return yield* emptyWorkspace()

  yield* registerIgnore({ worktreeDir: ctx.worktree, destinationRoot })

  const baseDirectory = input.parentWorkdir?.path ?? ctx.directory
  // `--verify -q` separates the three outcomes that matter. 0 resolves to a
  // commit. 1 means HEAD names a branch that does not exist yet -- a repository
  // that has been initialised and never committed to -- and says so quietly,
  // with an empty stderr. Anything else is a genuine failure and keeps the hard
  // error it always had, so a broken repository is not silently downgraded.
  const head = yield* runGit(["rev-parse", "--verify", "-q", "HEAD"], baseDirectory)
  if (head.code !== 0 && head.code !== 1) {
    return yield* new AgentManagement.WorktreeUnavailable({
      reason: `could not read HEAD of ${baseDirectory}: ${head.stderr || head.text}`,
      paths: [],
    })
  }
  const unborn = head.code === 1

  // Looked up rather than depended on. Making it a layer dependency would drag
  // the project store and its bootstrap into every layer that can reach the
  // Agent tools, which is most of them. Absent, the git branch simply reports
  // that it could not prepare a worktree.
  const worktree = Option.getOrUndefined(yield* Effect.serviceOption(Worktree.Service))
  if (!worktree) {
    return yield* new AgentManagement.WorktreeUnavailable({
      reason: "the worktree service is not available in this context",
      paths: [],
    })
  }
  const created = yield* worktree
    .createForAgent(
      unborn ? { destinationRoot, orphan: true } : { destinationRoot, baseCommit: head.text.trim() },
    )
    .pipe(Effect.exit)
  if (Exit.isFailure(created)) {
    // An unborn HEAD needs `worktree add --orphan`, which git only grew in
    // 2.42 -- and Ubuntu 22.04 and Debian 12 are both still supported with
    // older ones. Rather than parse `git --version`, whose release suffixes and
    // `2.42.0.windows.1` forms are their own trap, the call is simply attempted
    // and an empty workspace serves where it fails: that is what a project
    // without git already gets, and a repository with nothing committed is in
    // the same position. The reason travels back so the caller is not left
    // wondering why a git project produced no worktree.
    if (unborn) {
      return yield* emptyWorkspace(
        `${baseDirectory} has no commits yet and this git could not create a worktree without one, so the workspace starts empty. Commit something for later subagents to get a real worktree, or pass cwd to place one somewhere specific.`,
      )
    }
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
const registerIgnore = Effect.fn("AgentWorkdir.registerIgnore")(function* (input: {
  worktreeDir: string
  destinationRoot: string
}) {
  const fs = yield* FSUtil.Service
  const pathSvc = yield* Path.Path
  const located = yield* runGit(
    ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
    input.worktreeDir,
  )
  if (located.code !== 0) return
  const file = located.text.trim()
  if (!file) return

  // info/exclude takes the same patterns as .gitignore, and a pattern with a
  // slash anywhere but the end is anchored to the file's own directory — the
  // repository root. So the pattern has to be the destination's path relative to
  // the worktree, not a fixed string: started from packages/opencode, the
  // workspaces live at <repo>/packages/opencode/.opencode/worktrees while a
  // hardcoded `/.opencode/worktrees` names something else entirely, and git
  // status shows them all.
  const relative = pathSvc.relative(input.worktreeDir, input.destinationRoot)
  // A pattern can only describe something inside the repository, so if the
  // destination is outside it there is nothing correct to write.
  if (!relative || relative.startsWith("..") || pathSvc.isAbsolute(relative)) return

  const entry = `/${escapeIgnorePattern(relative)}`
  const existing = (yield* fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))) ?? ""
  if (existing.split("\n").some((line) => line.trim() === entry)) return

  const next = existing.trimEnd()
  yield* fs
    .writeFileString(file, next ? `${next}\n${entry}\n` : `${entry}\n`)
    .pipe(Effect.catch(() => Effect.void))
})

/**
 * Turns a path into a gitignore pattern that matches it literally.
 *
 * Two separate hazards. A backslash is gitignore's escape character rather than
 * a separator, so a Windows path written as-is is not a valid pattern at all.
 * And the directory name comes from the user's own project path, which may
 * contain `*`, `?`, `[`, `]`, a leading `#` or `!` — each of which means
 * something other than itself. A trailing space is dropped unless kept with a
 * backslash.
 */
export function escapeIgnorePattern(relative: string) {
  const normalised = relative.replaceAll("\\", "/")
  const escaped = normalised.replace(/([\\*?\[\]])/g, "\\$1")
  const leading = /^[#!]/.test(escaped) ? `\\${escaped}` : escaped
  return leading.endsWith(" ") ? `${leading.slice(0, -1)}\\ ` : leading
}

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
