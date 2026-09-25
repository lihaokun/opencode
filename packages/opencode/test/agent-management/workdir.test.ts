import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppProcess } from "@opencode-ai/core/process"
import { Effect } from "effect"
import { Git } from "@/git"
import { path as pathNode } from "@opencode-ai/core/effect/app-node-platform"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { Worktree } from "@/worktree"
import { AgentManagement } from "@/agent-management/schema"
import { AgentWorkdir } from "@/agent-management/workdir"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([Worktree.node, FSUtil.node, Git.node, pathNode, AppProcess.node]), [
    [InstanceStore.bootstrapNode, InstanceBootstrap.node],
  ]),
)
const gitOnly = process.platform !== "win32" ? it.instance : it.instance.skip

describe("agent working directory", () => {
  // The reason this test exists: the public Worktree.create adds the worktree
  // with --no-checkout and forks the populating reset, so it returns while the
  // directory still holds nothing but git metadata. An agent started against
  // that would begin in an empty tree and see none of the project.
  gitOnly(
    "hands back a worktree whose tracked files are already readable",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* FSUtil.Service
        const tracked = path.join(test.directory, "tracked.txt")
        yield* fs.writeFileString(tracked, "content that must be present\n")
        yield* run(test.directory, ["add", "tracked.txt"])
        yield* run(test.directory, ["commit", "-m", "add tracked file"])

        const result = yield* AgentWorkdir.prepareWorkdir({})

        expect(result.source).toBe("generated_git_worktree")
        // Read immediately, with no waiting of any kind: the contract is that
        // it is ready on return, not ready soon.
        const inside = path.join(result.path, "tracked.txt")
        expect(yield* fs.existsSafe(inside)).toBe(true)
        expect(yield* fs.readFileStringSafe(inside)).toBe("content that must be present\n")
      }),
    { git: true },
  )

  gitOnly(
    "registers the workspace root in info/exclude, once",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* FSUtil.Service
        yield* fs.writeFileString(path.join(test.directory, "tracked.txt"), "x\n")
        yield* run(test.directory, ["add", "tracked.txt"])
        yield* run(test.directory, ["commit", "-m", "init"])

        yield* AgentWorkdir.prepareWorkdir({})
        yield* AgentWorkdir.prepareWorkdir({})

        const exclude = path.join(test.directory, ".git", "info", "exclude")
        const body = (yield* fs.readFileStringSafe(exclude)) ?? ""
        const entries = body.split("\n").filter((line) => line.trim() === `/${AgentWorkdir.WORKTREE_ROOT}`)
        // Repeated preparation must not keep appending the same line.
        expect(entries).toHaveLength(1)
      }),
    { git: true },
  )

  it.instance("records a provided cwd without creating anything", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const absolute = path.join(instance.directory, "somewhere")
      const result = yield* AgentWorkdir.prepareWorkdir({ cwd: absolute })
      expect(result).toEqual({ path: absolute, source: "provided_cwd" })
    }))

  // The reason this test exists: `git init` with nothing committed leaves HEAD
  // naming a branch that does not exist, and `prepareWorkdir` used to read it
  // with a plain `rev-parse HEAD` and fail the whole creation. Nothing can be
  // branched from, but git will still open a worktree on a branch with no
  // history, which is what a repository with no commits has to offer.
  gitOnly(
    "opens a worktree for a repository that has no commits yet",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        // The fixture commits a root commit of its own, so the branch ref is
        // dropped to put HEAD back where `git init` leaves it. HEAD keeps
        // naming the branch; the branch simply has nothing behind it.
        const branch = (yield* run(test.directory, ["symbolic-ref", "--short", "HEAD"])).trim()
        yield* run(test.directory, ["update-ref", "-d", `refs/heads/${branch}`])

        const result = yield* AgentWorkdir.prepareWorkdir({})

        expect(result.source).toBe("generated_git_worktree")
        const fs = yield* FSUtil.Service
        expect(yield* fs.existsSafe(result.path)).toBe(true)
        // The repository is left exactly as it was found. Creating a commit to
        // give HEAD something to point at would have worked too, and would have
        // written to history the caller never asked to change.
        const count = (yield* run(test.directory, ["rev-list", "--all", "--count"])).trim()
        expect(count).toBe("0")
      }),
    { git: true },
  )

  // Guards the other direction: the unborn branch must not swallow ordinary
  // repositories. An orphan worktree for one that has commits would hand the
  // subagent an empty directory and none of the project.
  gitOnly(
    "still branches from HEAD when the repository has commits",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* FSUtil.Service
        yield* fs.writeFileString(path.join(test.directory, "tracked.txt"), "present\n")
        yield* run(test.directory, ["add", "tracked.txt"])
        yield* run(test.directory, ["commit", "-m", "add tracked file"])

        // Typed against the contract rather than the inferred union: `note` is
        // optional on AgentWorkdir, and asserting its absence is the point.
        const result: Omit<AgentManagement.AgentWorkdir, "enforced"> = yield* AgentWorkdir.prepareWorkdir({})

        expect(result.source).toBe("generated_git_worktree")
        expect(result.note).toBeUndefined()
        expect(yield* fs.existsSafe(path.join(result.path, "tracked.txt"))).toBe(true)
      }),
    { git: true },
  )

  // The value is stored on the session and read back later, so a relative one
  // would mean whatever the reader's process directory happened to be — the
  // same workspace landing somewhere else on a later read.
  it.instance("resolves a relative cwd against the session's own directory", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const result = yield* AgentWorkdir.prepareWorkdir({ cwd: "./somewhere" })
      expect(result).toEqual({ path: path.join(instance.directory, "somewhere"), source: "provided_cwd" })
    }))
})

const run = Effect.fn("WorkdirTest.git")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service
  const result = yield* service.run(args, { cwd })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`)
  return result.text()
})
