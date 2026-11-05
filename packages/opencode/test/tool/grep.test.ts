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
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "sibling.txt"), "line2\n"))
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
      expect(result.output).not.toContain("sibling.txt")
    }),
  )

  it.instance("a file with no matches does not search its siblings", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "target.txt")
      yield* Effect.promise(() => Bun.write(file, "unrelated text\n"))
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "sibling.txt"), "needle\n"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute({ pattern: "needle", path: file }, ctx)
      expect(result.metadata.matches).toBe(0)
      expect(result.output).toBe("No files found")
      const directory = yield* grep.execute({ pattern: "needle", path: test.directory }, ctx)
      expect(directory.metadata.matches).toBe(1)
      expect(directory.output).toContain("sibling.txt")
    }),
  )

  it.instance("relative file paths with special names remain exact with include", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "nested", "-target [1].txt")
      yield* Effect.promise(() => Bun.write(file, "needle\n"))
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "nested", "sibling.txt"), "needle\n"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const input = { pattern: "needle", path: path.relative(test.directory, file) }
      const result = yield* grep.execute({ ...input, include: "*.txt" }, ctx)
      expect(result.metadata.matches).toBe(1)
      expect(result.output).toContain("-target [1].txt")
      expect(result.output).not.toContain("sibling.txt")
      // Like the existing backend, an explicit file wins over include globs.
      const explicit = yield* grep.execute({ ...input, include: "*.md" }, ctx)
      expect(explicit.metadata.matches).toBe(1)
      expect(explicit.output).not.toContain("sibling.txt")
    }),
  )

  it.instance("missing search paths fail instead of searching their parent", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "sibling.txt"), "needle\n"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      for (const name of ["missing.txt", "missing-dir"]) {
        const exit = yield* grep
          .execute({ pattern: "needle", path: path.join(test.directory, name) }, ctx)
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(String(Cause.squash(exit.cause))).toContain("Search path not found:")
          expect(String(Cause.squash(exit.cause))).toContain(name)
        }
      }
    }),
  )

  it.instance("an exact file named dash is not treated as stdin", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "-")
      yield* Effect.promise(() => Bun.write(file, "needle\n"))
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "sibling.txt"), "needle\n"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      for (const target of [file, "./-"]) {
        const result = yield* grep.execute({ pattern: "needle", path: target }, ctx)
        expect(result.metadata.matches).toBe(1)
        expect(result.output).toContain(`${file}:`)
        expect(result.output).toContain("Line 1: needle")
        expect(result.output).not.toContain("sibling.txt")
      }
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

  // The shorthand must reach ripgrep: before = after = context, and an
  // explicit side overrides the shorthand for that side only.
  it.instance("context shorthand expands to before and after, explicit sides win", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "sh.txt"), "b1\nb2\nMIDDLE\na2\na1\n"))
      const info = yield* GrepTool
      const grep = yield* info.init()

      const both = yield* grep.execute(
        { pattern: "MIDDLE", path: test.directory, include: "sh.txt", context: 2 },
        ctx,
      )
      expect(both.output).toContain("Line 1- b1")
      expect(both.output).toContain("Line 5- a1")

      const mixed = yield* grep.execute(
        { pattern: "MIDDLE", path: test.directory, include: "sh.txt", context: 2, after: 1 },
        ctx,
      )
      expect(mixed.output).toContain("Line 1- b1")
      expect(mixed.output).toContain("Line 4- a2")
      expect(mixed.output).not.toContain("Line 5- a1")
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

      // offset beyond results is distinct from no matches at all, and the
      // total shown is the real match count (5), not the empty page length.
      const beyond = yield* grep.execute(
        { pattern: "needle", path: test.directory, include: "p*.txt", head_limit: 2, offset: 9 },
        ctx,
      )
      expect(beyond.output).toContain("No matches at offset 9 (total matches: 5)")
      expect(beyond.output).not.toContain("No files found")
      // The metadata of an empty page still reflects this request.
      expect(beyond.metadata).toMatchObject({ matches: 0, truncated: false, output_mode: "content", offset: 9 })
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

  // Schema-level guards: a negative offset or zero limit would degenerate the
  // pagination window (nonsense ranges, empty pages reported as truncated).
  // The dedicated invalid-pattern channel must survive the search rewrite:
  // an illegal expression is a diagnostic error, not a generic failure.
  it.instance("invalid regex reports the ripgrep parse error", () =>
    Effect.gen(function* () {
      const info = yield* GrepTool
      const grep = yield* info.init()
      const exit = yield* Effect.exit(grep.execute({ pattern: "[", path: "/" }, ctx))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = String(Cause.squash(exit.cause))
        expect(message.toLowerCase()).toContain("regex parse error")
      }
    }),
  )

  it.instance("rejects negative offset and non-positive head_limit at the schema", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "f.txt"), "needle\n"))
      const info = yield* GrepTool
      const grep = yield* info.init()

      const negativeOffset = yield* Effect.exit(
        grep.execute({ pattern: "needle", path: test.directory, offset: -5 }, ctx),
      )
      expect(Exit.isFailure(negativeOffset)).toBe(true)

      const zeroLimit = yield* Effect.exit(
        grep.execute({ pattern: "needle", path: test.directory, head_limit: 0 }, ctx),
      )
      expect(Exit.isFailure(zeroLimit)).toBe(true)
    }),
  )

  // #107: single-file scoping — an exact file target searches only that file
  // (a bare "-" basename would read stdin to rg; symlinks keep the requested
  // name and never leak sibling matches). Applies to the multi-mode tool too.
  it.instance("an exact symlink file keeps its requested name and excludes siblings", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const test = yield* TestInstance
      const real = path.join(test.directory, "real.txt")
      const alias = path.join(test.directory, "alias.txt")
      yield* Effect.promise(() => Bun.write(real, "needle\n"))
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "sibling.txt"), "needle\n"))
      yield* Effect.promise(() => fs.symlink(real, alias))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute({ pattern: "needle", path: alias }, ctx)
      expect(result.metadata.matches).toBe(1)
      expect(result.output).toContain(alias)
      expect(result.output).not.toContain(real)
      expect(result.output).not.toContain("sibling.txt")
    }),
  )
})

// R2: every page is an independent rg invocation, so pagination only works if
// the traversal order is identical across invocations. Walk a wider tree in
// pages and demand the union is exactly the file set — no duplicates, no gaps.
// The oracle keys on dir/file pairs (base names repeat across directories).
it.instance("pagination across invocations covers every file exactly once", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    for (let dir = 0; dir < 11; dir += 1) {
      for (let file = 0; file < 15; file += 1) {
        yield* Effect.promise(() =>
          Bun.write(path.join(test.directory, `d${dir}`, `f${file}.txt`), "needle\n"),
        )
      }
    }
    const info = yield* GrepTool
    const grep = yield* info.init()

    for (const mode of ["files_with_matches", "count", "content"] as const) {
      const seen: string[] = []
      for (let offset = 0; offset < 165; offset += 20) {
        const page = yield* grep.execute(
          { pattern: "needle", path: test.directory, output_mode: mode, head_limit: 20, offset },
          ctx,
        )
        // The tool renders absolute paths; key the oracle on dir/file pairs so
        // identical base names in different directories stay distinct.
        seen.push(...(page.output.match(/d\d+[\\/]f\d+\.txt/g) ?? []))
      }
      const unique = new Set(seen)
      expect(unique.size).toBe(165)
      expect(seen.length).toBe(unique.size)
    }
  }),
  30_000,
)

// R7a: an offset past the last match must yield an empty page — the trailing
// context of the final (skipped) match is not a result.
it.instance("offset beyond the last match returns no context-only rows", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* Effect.promise(() => Bun.write(path.join(test.directory, "r7a.txt"), "hit\nnot-a-match\n"))
    const info = yield* GrepTool
    const grep = yield* info.init()

    const beyond = yield* grep.execute(
      { pattern: "^hit$", path: test.directory, include: "r7a.txt", after: 1, offset: 1, head_limit: 1 },
      ctx,
    )
    expect(beyond.metadata).toMatchObject({ matches: 0 })
    expect(beyond.output).toContain("No matches at offset 1")
    expect(beyond.output).not.toContain("not-a-match")
  }),
)

// R7b: the "Showing matches" range counts matches; context rows ride along
// without inflating the window.
it.instance("showing-range counts matches, not context rows", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* Effect.promise(() =>
      Bun.write(path.join(test.directory, "r7b.txt"), "hit\nafter\nhit\nafter\n"),
    )
    const info = yield* GrepTool
    const grep = yield* info.init()

    const page = yield* grep.execute(
      { pattern: "hit", path: test.directory, include: "r7b.txt", context: 1, offset: 1, head_limit: 1 },
      ctx,
    )
    // One match admitted (the second "hit"); its before/after context rows
    // appear in the listing but the range says exactly one match: 2-2.
    expect(page.output).toContain("Showing matches 2-2 (offset 1, limit 1)")
  }),
)

// Negative context values are rejected at the schema layer, not silently
// treated as zero.
it.instance("negative context parameters are rejected", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* Effect.promise(() => Bun.write(path.join(test.directory, "neg.txt"), "needle\n"))
    const info = yield* GrepTool
    const grep = yield* info.init()

    for (const params of [
      { context: -1 },
      { before: -2 },
      { after: -3 },
    ] as const) {
      const exit = yield* Effect.exit(
        grep.execute({ pattern: "needle", path: test.directory, ...params }, ctx),
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }
  }),
)
