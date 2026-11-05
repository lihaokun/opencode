import path from "path"
import { Effect, Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "@opencode-ai/core/schema"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./grep.txt"
import * as Tool from "./tool"

// Step P1: schema — every new parameter optional; absent = legacy behavior.
export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The regex pattern to search for in file contents" }),
  path: Schema.optional(Schema.String).annotate({
    description: "The file or directory to search in. Defaults to the current working directory.",
  }),
  include: Schema.optional(Schema.String).annotate({
    description: 'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")',
  }),
  output_mode: Schema.optional(
    Schema.Literals(["content", "files_with_matches", "count"]),
  ).annotate({
    description:
      "Output format: 'content' shows matching lines (default), 'files_with_matches' lists matching file paths, 'count' shows match counts per file",
  }),
  insensitive: Schema.optional(Schema.Boolean).annotate({
    description: "Case-insensitive search",
  }),
  before: Schema.optional(NonNegativeInt).annotate({
    description: "Lines of context before each match, content mode only (max 10)",
  }),
  after: Schema.optional(NonNegativeInt).annotate({
    description: "Lines of context after each match, content mode only (max 10)",
  }),
  context: Schema.optional(NonNegativeInt).annotate({
    description:
      "Lines of context before and after each match, content mode only (max 10). Shorthand for before and after together; an explicit before or after overrides it for that side",
  }),
  offset: Schema.optional(NonNegativeInt).annotate({
    description: "Skip the first N results (for pagination)",
  }),
  head_limit: Schema.optional(PositiveInt).annotate({
    description: "Maximum number of results to return (default 100)",
  }),
})

export const GrepTool = Tool.define(
  "grep",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (
        params: {
          pattern: string
          path?: string
          include?: string
          output_mode?: "content" | "files_with_matches" | "count"
          insensitive?: boolean
          before?: number
          after?: number
          context?: number
          offset?: number
          head_limit?: number
        },
        ctx: Tool.Context,
      ) =>
        Effect.gen(function* () {
          if (!params.pattern) {
            throw new Error("pattern is required")
          }
          const mode = params.output_mode ?? "content"
          // Step P2: validation — context caps and content-mode-only rule.
          const context = params.context ?? 0
          // Step P4: `context` is the shorthand for both sides; an explicit
          // before/after wins over it per side, so {context: 3, after: 1} reads
          // as before=3, after=1.
          const before = params.before ?? context
          const after = params.after ?? context
          if (before > 10 || after > 10 || context > 10) {
            throw new Error("context lines are capped at 10 (before/after/context)")
          }
          if (mode !== "content" && (before > 0 || after > 0 || context > 0)) {
            throw new Error("context lines only apply to output_mode=content")
          }
          const headLimit = params.head_limit ?? 100
          const offset = params.offset ?? 0
          // Empty-result metadata reflects THIS request (mode/offset/limit),
          // not hardcoded defaults — a caller reading metadata after a
          // beyond-window result still sees what was asked.
          const empty = {
            title: params.pattern,
            metadata: { matches: 0, truncated: false, output_mode: mode, offset, head_limit: headLimit },
            output: "No files found",
          }

          // Step P3: permission ask (patterns=[pattern], unchanged).
          yield* ctx.ask({
            permission: "grep",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
              include: params.include,
            },
          })

          // Step P5: path resolution + external-directory assertion (existing).
          const ins = yield* InstanceState.context
          const requested = path.isAbsolute(params.path ?? ins.directory)
            ? (params.path ?? ins.directory)
            : path.join(ins.directory, params.path ?? ".")
          const requestedInfo = yield* fs.stat(requested).pipe(Effect.catch(() => Effect.succeed(undefined)))
          yield* assertExternalDirectoryEffect(ctx, requested, {
            bypass: false,
            kind: requestedInfo?.type === "Directory" ? "directory" : "file",
          })

          const search = FSUtil.resolve(requested)
          // #107 hardened path handling: missing paths reject instead of
          // silently degrading to a cwd search, non-file/dir shapes are
          // refused, and a single-file target scopes rg to exactly that file
          // (a bare "-" basename would mean stdin to rg even after "--").
          // Our multi-mode branch keeps those semantics; the catch-to-
          // undefined variant is gone.
          const info = yield* fs
            .stat(search)
            .pipe(
              Effect.catchReason("PlatformError", "NotFound", () =>
                Effect.fail(new Error(`Search path not found: ${requested}`)),
              ),
            )
          if (info.type !== "Directory" && info.type !== "File") {
            throw new Error(`Search path must be a file or directory: ${requested}`)
          }
          const cwd = info.type === "Directory" ? search : path.dirname(search)
          // Step P6: dispatch rg args by mode (content --json; files
          // --files-with-matches; count --count-matches; -B/-A, -i, --sort).
          const result = yield* ripgrep.search({
            cwd,
            pattern: params.pattern,
            // A bare "-" means stdin to ripgrep, even after "--".
            file: info.type === "File" ? `./${path.basename(search)}` : undefined,
            include: params.include,
            limit: headLimit,
            offset,
            mode,
            insensitive: params.insensitive ?? false,
            before,
            after,
          })

          // Step P9: render (absolute paths) + pagination outcome copy.
          // The service returns search-relative paths; render absolute paths
          // like the legacy projection did, in every mode. #107: FSUtil.resolve
          // follows symlinks, so a File target must render back to the
          // REQUESTED path, not the realpath rg reported under.
          const rowBase = requested
          const requestedFile = info.type === "File" ? requested : undefined

          // `matches` counts match entries, not rendered rows: context rows ride
          // along in content mode but are not matches. The service's `total` is
          // the match/file count in every mode, so reuse it.
          const metadata = {
            matches: result.total,
            truncated: result.hasMore,
            output_mode: mode,
            offset,
            head_limit: headLimit,
          }
          const tail = result.hasMore
            ? [``, `(more results available; increase offset to ${offset + headLimit})`]
            : []

          if (result.mode === "files_with_matches") {
            if (result.files.length === 0) {
              return {
                ...empty,
                metadata: { ...metadata, matches: 0 },
                output:
                  offset > 0
                    ? `No files at offset ${offset} (total files: ${result.total})`
                    : "No files found",
              }
            }
            const output = [
              `Found ${result.files.length} files`,
              // #107: a File target renders back as the requested path even
              // when rg matched through a symlink (FSUtil.resolve realpaths).
              ...(requestedFile
                ? [requestedFile]
                : result.files.map((file) => path.resolve(rowBase, file))),
              ...tail,
            ]
            return { title: params.pattern, metadata, output: output.join("\n") }
          }

          if (result.mode === "count") {
            if (result.counts.length === 0) {
              return {
                ...empty,
                output: offset > 0 ? `No matches at offset ${offset} (total matches: ${result.total})` : "No files found",
              }
            }
            const totalMatches = result.counts.reduce((sum: number, item) => sum + item.count, 0)
            const output = [
              `Found ${result.counts.length} files with ${totalMatches} matches`,
              ...(requestedFile
                ? [`${requestedFile}: ${result.counts[0]?.count ?? 0} matches`]
                : result.counts.map((item) => `${path.resolve(rowBase, item.path)}: ${item.count} matches`)),
              ...tail,
            ]
            return { title: params.pattern, metadata, output: output.join("\n") }
          }

          if (result.rows.length === 0) {
            return {
              ...empty,
              output:
                offset > 0
                  ? `No matches at offset ${offset} (total matches: ${result.total})`
                  : "No files found",
            }
          }

          // The service returns search-relative paths; render absolute paths
          // like the legacy projection did. A File target renders back as the
          // requested path (symlink name preserved).
          const rows = result.rows.map((row) => ({
            ...row,
            path: requestedFile ?? path.resolve(rowBase, row.path),
          }))

          const output = [`Found ${result.total} matches`]
          // The shown range counts MATCH rows only — context rows ride along
          // but are not results, so rows.length would overstate the window.
          const matchCount = rows.filter((row) => !row.context).length
          if (offset > 0 || result.hasMore) {
            output.push(
              `Showing matches ${offset + 1}-${offset + matchCount} (offset ${offset}, limit ${headLimit})`,
            )
          }
          let current = ""
          for (const row of rows) {
            if (current !== row.path) {
              if (current !== "") output.push("")
              current = row.path
              output.push(`${row.path}:`)
            }
            output.push(`  Line ${row.line}${row.context ? "-" : ":"} ${row.text}`)
          }
          output.push(...tail)

          return { title: params.pattern, metadata, output: output.join("\n") }
        }).pipe(Effect.orDie),
    }
  }),
)
