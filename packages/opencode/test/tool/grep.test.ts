import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import { GrepTool } from "../../src/tool/grep"
import { provideInstance, testInstanceStoreLayer, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { testEffect } from "../lib/effect"
import { Permission } from "../../src/permission"
import type * as Tool from "../../src/tool/tool"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Git } from "@/git"
import { Filesystem } from "@/util/filesystem"

const toolLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Ripgrep.node, Truncate.node, Agent.node, Git.node]),
  )

const it = testEffect(toolLayer())
const rooted = testEffect(Layer.mergeAll(toolLayer(), testInstanceStoreLayer))

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const root = path.join(__dirname, "../..")
const full = (p: string) => (process.platform === "win32" ? Filesystem.normalizePath(p) : p)

const githubBase = <A, E, R>(url: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
      process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL = url
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous) process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL = previous
        else delete process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
      }),
  )

const git = Effect.fn("GrepToolTest.git")(function* (cwd: string, args: string[]) {
  return yield* Effect.promise(async () => {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed`)
    return stdout.trim()
  })
})

describe("tool.grep", () => {
  rooted.live("basic search", () =>
    Effect.gen(function* () {
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* provideInstance(root)(
        grep.execute(
          {
            pattern: "export",
            path: path.join(root, "src/tool"),
            include: "*.ts",
          },
          ctx,
        ),
      )
      expect(result.metadata.matches).toBeGreaterThan(0)
      expect(result.output).toContain("Found")
    }),
  )

  it.instance("no matches returns correct output", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "test.txt"), "hello world"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        {
          pattern: "xyznonexistentpatternxyz123",
          path: test.directory,
        },
        ctx,
      )
      expect(result.metadata.matches).toBe(0)
      expect(result.output).toBe("No files found")
    }),
  )

  it.instance("finds matches in tmp instance", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "test.txt"), "line1\nline2\nline3"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        {
          pattern: "line",
          path: test.directory,
        },
        ctx,
      )
      expect(result.metadata.matches).toBeGreaterThan(0)
    }),
  )

  it.instance("does not report an unknown total when results are truncated", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        Promise.all(
          Array.from({ length: 101 }, (_, index) =>
            Bun.write(path.join(test.directory, `match-${index}.txt`), "needle"),
          ),
        ),
      )
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute({ pattern: "needle", path: test.directory, include: "*.txt" }, ctx)

      // The tail wording was redesigned with pagination (grep extension): the
      // regression target here is that a truncated result never claims an
      // unknown total, and the new copy points at the offset escape hatch.
      expect(result.output).toContain("Showing matches 1-100 (offset 0, limit 100)")
      expect(result.output).toContain("(more results available; increase offset to 100)")
      expect(result.output).not.toMatch(/showing \d+ of \d+ matches/)
    }),
  )

  it.instance("supports exact file paths", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "test.txt")
      yield* Effect.promise(() => Bun.write(file, "line1\nline2\nline3"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        {
          pattern: "line2",
          path: file,
        },
        ctx,
      )
      expect(result.metadata.matches).toBe(1)
      expect(result.output).toContain(file)
      expect(result.output).toContain("Line 2: line2")
    }),
  )

  it.instance("does not ask for external_directory when alias path is allowed", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return

      yield* TestInstance
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-grep-alias-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
      )
      const real = path.join(tmp, "real")
      const alias = path.join(tmp, "alias")
      yield* Effect.promise(() => fs.mkdir(real))
      yield* Effect.promise(() => fs.symlink(real, alias, "dir"))
      yield* Effect.promise(() => Bun.write(path.join(real, "test.txt"), "needle"))

      const ruleset = Permission.fromConfig({
        grep: "allow",
        external_directory: {
          [path.join(alias, "*")]: "allow",
        },
      })
      const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
      const next: Tool.Context = {
        ...ctx,
        ask: (req) =>
          Effect.sync(() => {
            const needsAsk = req.patterns.some(
              (pattern) => Permission.evaluate(req.permission, pattern, ruleset).action !== "allow",
            )
            if (needsAsk) requests.push(req)
          }),
      }

      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        {
          pattern: "needle",
          path: alias,
          include: "*.txt",
        },
        next,
      )

      expect(result.metadata.matches).toBe(1)
      expect(result.output).toContain(path.join(alias, "test.txt"))
      expect(result.output).not.toContain(path.join(real, "test.txt"))
      expect(requests.find((req) => req.permission === "external_directory")).toBeUndefined()
    }),
  )

  it.instance("files_with_matches mode lists matching file paths", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "a.txt"), "needle\n"))
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "b.txt"), "needle\n"))
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "c.md"), "needle\n"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        { pattern: "needle", path: test.directory, include: "*.txt", output_mode: "files_with_matches" },
        ctx,
      )
      expect(result.output).toContain("Found 2 files")
      expect(result.output).toContain(path.join(test.directory, "a.txt"))
      expect(result.output).toContain(path.join(test.directory, "b.txt"))
      expect(result.output).not.toContain("c.md")
    }),
  )

  it.instance("count mode reports per-file match counts", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "a.txt"), "x\nx\nx\n"))
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "b.txt"), "x\n"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        { pattern: "x", path: test.directory, include: "*.txt", output_mode: "count" },
        ctx,
      )
      expect(result.output).toContain("Found 2 files with 4 matches")
      expect(result.output).toContain("a.txt: 3 matches")
      expect(result.output).toContain("b.txt: 1 matches")
    }),
  )

  it.instance("count mode handles a single-file search target", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "solo.txt")
      yield* Effect.promise(() => Bun.write(file, "x\nx\n"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        { pattern: "x", path: file, output_mode: "count" },
        ctx,
      )
      expect(result.output).toContain("Found 1 files with 2 matches")
      expect(result.output).toContain(file)
    }),
  )

  it.instance("content mode renders context lines with dash prefixes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "ctx.txt"), "before\nMIDDLE\nafter\n"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        { pattern: "MIDDLE", path: test.directory, include: "ctx.txt", before: 1, after: 1 },
        ctx,
      )
      expect(result.output).toContain("Line 1- before")
      expect(result.output).toContain("Line 2: MIDDLE")
      expect(result.output).toContain("Line 3- after")
    }),
  )

  it.instance("pagination distinguishes has-more, exact end and offset beyond", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      for (let index = 0; index < 5; index += 1) {
        yield* Effect.promise(() => Bun.write(path.join(test.directory, `p${index}.txt`), "needle\n"))
      }
      const info = yield* GrepTool
      const grep = yield* info.init()

      // has-more
      const page = yield* grep.execute(
        { pattern: "needle", path: test.directory, include: "p*.txt", head_limit: 2 },
        ctx,
      )
      expect(page.output).toContain("Showing matches 1-2 (offset 0, limit 2)")
      expect(page.output).toContain("(more results available; increase offset to 2)")

      // exact end
      const last = yield* grep.execute(
        { pattern: "needle", path: test.directory, include: "p*.txt", head_limit: 2, offset: 4 },
        ctx,
      )
      expect(last.output).toContain("Showing matches 5-5 (offset 4, limit 2)")
      expect(last.output).not.toContain("more results available")

      // offset beyond results is distinct from no matches at all
      const beyond = yield* grep.execute(
        { pattern: "needle", path: test.directory, include: "p*.txt", head_limit: 2, offset: 9 },
        ctx,
      )
      expect(beyond.output).toContain("No matches at offset 9")
      expect(beyond.output).not.toContain("No files found")
    }),
  )

  it.instance("insensitive search matches case variants", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "case.txt"), "HeLLo\n"))
      const info = yield* GrepTool
      const grep = yield* info.init()

      const sensitive = yield* grep.execute({ pattern: "hello", path: test.directory }, ctx)
      expect(sensitive.output).toContain("No files found")

      const loose = yield* grep.execute({ pattern: "hello", path: test.directory, insensitive: true }, ctx)
      expect(loose.output).toContain("HeLLo")
    }),
  )

  it.instance("rejects oversized context and context outside content mode", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "f.txt"), "needle\n"))
      const info = yield* GrepTool
      const grep = yield* info.init()

      const oversized = yield* Effect.exit(
        grep.execute({ pattern: "needle", path: test.directory, context: 11 }, ctx),
      )
      expect(Exit.isFailure(oversized)).toBe(true)

      const wrongMode = yield* Effect.exit(
        grep.execute(
          { pattern: "needle", path: test.directory, output_mode: "files_with_matches", context: 2 },
          ctx,
        ),
      )
      expect(Exit.isFailure(wrongMode)).toBe(true)
      if (Exit.isFailure(wrongMode)) {
        expect(String(Cause.squash(wrongMode.cause))).toContain("only apply to output_mode=content")
      }
    }),
  )
})
