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
      const result = yield* AgentWorkdir.prepareWorkdir({ cwd: "/tmp/somewhere" })
      expect(result).toEqual({ path: "/tmp/somewhere", source: "provided_cwd" })
    }))
})

const run = Effect.fn("WorkdirTest.git")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service
  const result = yield* service.run(args, { cwd })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`)
  return result.text()
})
