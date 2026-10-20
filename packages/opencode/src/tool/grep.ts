import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./grep.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The regex pattern to search for in file contents" }),
  path: Schema.optional(Schema.String).annotate({
    description: "The directory to search in. Defaults to the current working directory.",
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
  before: Schema.optional(Schema.Number).annotate({
    description: "Lines of context before each match, content mode only (max 10)",
  }),
  after: Schema.optional(Schema.Number).annotate({
    description: "Lines of context after each match, content mode only (max 10)",
  }),
  context: Schema.optional(Schema.Number).annotate({
    description:
      "Lines of context before and after each match, content mode only (max 10). Shorthand for before and after together; an explicit before or after overrides it for that side",
  }),
  offset: Schema.optional(Schema.Number).annotate({
    description: "Skip the first N results (for pagination)",
  }),
  head_limit: Schema.optional(Schema.Number).annotate({
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
          const empty = {
            title: params.pattern,
            metadata: { matches: 0, truncated: false, output_mode: "content", offset: 0, head_limit: 100 },
            output: "No files found",
          }
          if (!params.pattern) {
            throw new Error("pattern is required")
          }
          const mode = params.output_mode ?? "content"
          const context = params.context ?? 0
          // `context` is the shorthand for both sides; an explicit before/after
          // wins over it per side, so {context: 3, after: 1} reads as
          // before=3, after=1.
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
          const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          const cwd = info?.type === "Directory" ? search : path.dirname(search)
          const result = yield* ripgrep.search({
            cwd,
            pattern: params.pattern,
            include: params.include,
            limit: headLimit,
            offset,
            mode,
            insensitive: params.insensitive ?? false,
            before,
            after,
          })

          // The service returns search-relative paths; render absolute paths
          // like the legacy projection did, in every mode.
          const rowBase = requestedInfo?.type === "Directory" ? requested : path.dirname(requested)

          const metadata = {
            matches:
              result.mode === "content"
                ? result.rows.length
                : result.mode === "count"
                  ? result.counts.length
                  : result.files.length,
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
              ...result.files.map((file) => path.resolve(rowBase, file)),
              ...tail,
            ]
            return { title: params.pattern, metadata, output: output.join("\n") }
          }

          if (result.mode === "count") {
            if (result.counts.length === 0) {
              return {
                ...empty,
                output: offset > 0 ? `No matches at offset ${offset}` : "No files found",
              }
            }
            const totalMatches = result.counts.reduce((sum: number, item) => sum + item.count, 0)
            const output = [
              `Found ${result.counts.length} files with ${totalMatches} matches`,
              ...result.counts.map(
                (item) => `${path.resolve(rowBase, item.path)}: ${item.count} matches`,
              ),
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
          // like the legacy projection did.
          const rows = result.rows.map((row) => ({ ...row, path: path.resolve(rowBase, row.path) }))

          const output = [`Found ${result.total} matches`]
          if (offset > 0 || result.hasMore) {
            output.push(
              `Showing matches ${offset + 1}-${offset + result.rows.length} (offset ${offset}, limit ${headLimit})`,
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
