export * as Ripgrep from "./ripgrep"

import { Context, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Entry, Match } from "@opencode-ai/schema/filesystem"
import { makeGlobalNode } from "./effect/app-node"
import { AppProcess, collectStream, waitForAbort } from "./process"
import { NonNegativeInt, PositiveInt, RelativePath } from "./schema"
import { RipgrepBinary } from "./ripgrep/binary"

/**
 * Small core-owned ripgrep execution adapter. It deliberately exposes raw
 * process-oriented rows, not model text or permission behavior. Search maps
 * these rows into filesystem results; leaf tools own
 * presentation and permission prompts.
 */

const ERROR_BYTES = 8 * 1024
const MAX_RECORD_BYTES = 64 * 1024
const MAX_SUBMATCHES = 100

const RawMatch = Schema.Struct({
  type: Schema.Literals(["match", "context"]),
  data: Schema.Struct({
    path: Schema.Struct({ text: Schema.String }),
    lines: Schema.Struct({ text: Schema.String }),
    line_number: PositiveInt,
    absolute_offset: NonNegativeInt,
    submatches: Schema.Array(
      Schema.Struct({
        match: Schema.Struct({ text: Schema.String }),
        start: NonNegativeInt,
        end: NonNegativeInt,
      }),
    ),
  }),
})

type RawMatchData = (typeof RawMatch.Type)["data"]

export class Error extends Schema.TaggedErrorClass<Error>()("Ripgrep.Error", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class InvalidPatternError extends Schema.TaggedErrorClass<InvalidPatternError>()("Ripgrep.InvalidPatternError", {
  pattern: Schema.String,
  message: Schema.String,
}) {}

export interface FindInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
  readonly onEntry?: (entry: Entry) => Effect.Effect<void>
}

export interface GlobInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
}

export interface GrepInput {
  readonly cwd: string
  readonly pattern: string
  readonly file?: string
  readonly include?: string
  readonly limit: number
  readonly offset?: number
  readonly mode?: "content" | "files_with_matches" | "count"
  readonly insensitive?: boolean
  readonly before?: number
  readonly after?: number
  readonly signal?: AbortSignal
}

export interface GrepCount {
  readonly path: string
  readonly count: number
}

/** One rendered row of content-mode output; `context` rows are the -A/-B/-C neighborhood of a match. */
export interface GrepRow {
  readonly path: string
  readonly line: number
  readonly text: string
  readonly context: boolean
}

export type GrepResult =
  | { readonly mode: "content"; readonly rows: readonly GrepRow[]; readonly total: number; readonly hasMore: boolean }
  | { readonly mode: "files_with_matches"; readonly files: readonly string[]; readonly total: number; readonly hasMore: boolean }
  | { readonly mode: "count"; readonly counts: readonly GrepCount[]; readonly total: number; readonly hasMore: boolean }

export interface Interface {
  readonly find: (input: FindInput) => Effect.Effect<readonly Entry[], Error>
  readonly glob: (input: GlobInput) => Effect.Effect<readonly Entry[], Error>
  /** Legacy line-oriented grep returning schema Matches (used by filesystem search). */
  readonly grep: (input: GrepInput) => Effect.Effect<readonly Match[], Error | InvalidPatternError>
  /** Full-featured search: output modes, context lines, case handling, pagination. */
  readonly search: (input: GrepInput) => Effect.Effect<GrepResult, Error | InvalidPatternError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Ripgrep") {}

const failure = (message: string, cause?: unknown) => new Error({ message, cause })

const isInvalidPattern = (stderr: string) =>
  stderr.includes("regex parse error") || stderr.includes("error parsing regex")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const process = yield* AppProcess.Service
    const binary = yield* RipgrepBinary.Service

    const run = <A>(input: {
      readonly cwd: string
      readonly args: string[]
      readonly limit: number
      readonly offset?: number
      readonly signal?: AbortSignal
      readonly parse: (line: string) => Effect.Effect<A | undefined, Error>
      readonly pattern?: string
      readonly onItem?: (item: A) => Effect.Effect<void>
    }) => {
      const program = Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* process.spawn(
            ChildProcess.make(yield* binary.filepath, input.args, { cwd: input.cwd, extendEnv: true, stdin: "ignore" }),
          )
          const stderrFiber = yield* collectStream(handle.stderr, ERROR_BYTES).pipe(
            Effect.map((output) => output.buffer.toString("utf8")),
            Effect.forkScoped,
          )
          let observed = 0
          const offset = input.offset ?? 0
          const rows = yield* Stream.decodeText(handle.stdout).pipe(
            Stream.splitLines,
            Stream.filter((line) => line.length > 0),
            Stream.mapEffect(input.parse),
            Stream.filter((row): row is A => row !== undefined),
            Stream.tap((row) => {
              if (!input.onItem || observed++ >= input.limit + offset) return Effect.void
              return input.onItem(row)
            }),
            Stream.take(input.limit + offset + 1),
            Stream.runCollect,
            Effect.map((chunk) => [...chunk]),
          )
          const truncated = rows.length > input.limit + offset
          if (truncated) return { items: rows.slice(offset, offset + input.limit), truncated, partial: false }

          const code = yield* handle.exitCode
          const stderr = yield* Fiber.join(stderrFiber)
          if (input.pattern && code === 2 && isInvalidPattern(stderr)) {
            return yield* new InvalidPatternError({ pattern: input.pattern, message: stderr.trim() })
          }
          if (code !== 0 && code !== 1 && code !== 2) {
            return yield* failure(stderr.trim() || `ripgrep failed with code ${code}`)
          }
          return { items: rows.slice(offset, offset + input.limit), truncated: false, partial: code === 2 }
        }),
      )
      const abortable = input.signal ? program.pipe(Effect.raceFirst(waitForAbort(input.signal))) : program
      return abortable.pipe(
        Effect.mapError((cause) =>
          cause instanceof Error || cause instanceof InvalidPatternError
            ? cause
            : failure("ripgrep execution failed", cause),
        ),
      )
    }

    return Service.of({
      glob: (input) =>
        run<string>({
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          args: [
            "--no-config",
            "--files",
            ...(input.hidden ? ["--hidden"] : []),
            ...(input.follow ? ["--follow"] : []),
            `--glob=${input.pattern}`,
            "--glob=!**/.git/**",
            ".",
          ],
          parse: (line) =>
            Effect.succeed(
              line
                .replace(/^(?:\.[\\/])+/u, "")
                .replace(/^[\\/]+/u, "")
                .replaceAll("\\", "/"),
            ),
        }).pipe(
          Effect.map((result) =>
            result.items.map((relative) =>
              Entry.make({
                path: RelativePath.make(relative),
                type: "file",
              }),
            ),
          ),
          Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause))),
        ),
      find: (input) =>
        run<Entry>({
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          args: [
            "--no-config",
            "--files",
            ...(input.hidden ? ["--hidden"] : []),
            ...(input.follow ? ["--follow"] : []),
            ...(input.pattern === "*" ? [] : [`--glob=${input.pattern}`]),
            "--glob=!**/.git/**",
            ".",
          ],
          parse: (line) => {
            const relative = line
              .replace(/^(?:\.[\\/])+/u, "")
              .replace(/^[\\/]+/u, "")
              .replaceAll("\\", "/")
            return Effect.succeed(
              Entry.make({
                path: RelativePath.make(relative),
                type: "file",
              }),
            )
          },
          onItem: input.onEntry,
        }).pipe(
          Effect.map((result) => result.items),
          Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause))),
        ),
      grep: (input) =>
        run<RawMatchData>({
          ...input,
          args: [
            "--no-config",
            "--json",
            "--hidden",
            "--no-messages",
            ...(input.include ? [`--glob=${input.include}`] : []),
            "--glob=!**/.git/**",
            "--",
            input.pattern,
            input.file ?? ".",
          ],
          parse: (line) =>
            (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES
              ? Effect.fail(failure(`Ripgrep JSON record exceeded ${MAX_RECORD_BYTES} bytes`))
              : Effect.try({
                  try: () => JSON.parse(line) as unknown,
                  catch: (cause) => failure("Invalid ripgrep JSON output", cause),
                })
            ).pipe(
              Effect.flatMap((json) => {
                if (!json || typeof json !== "object" || !("type" in json) || json.type !== "match")
                  return Effect.succeed(undefined)
                return Schema.decodeUnknownEffect(RawMatch)(json).pipe(
                  Effect.map((match) => ({
                    ...match.data,
                    path: { text: match.data.path.text.replace(/^\.[\\/]/, "") },
                    submatches: match.data.submatches.slice(0, MAX_SUBMATCHES),
                  })),
                  Effect.mapError((cause) => failure("Invalid ripgrep match output", cause)),
                )
              }),
            ),
        }).pipe(
          Effect.map((result) =>
            result.items.map((match) => {
              const relative = match.path.text
                .replace(/^(?:\.[\\/])+/u, "")
                .replace(/^[\\/]+/u, "")
                .replaceAll("\\", "/")
              return Match.make({
                entry: Entry.make({
                  path: RelativePath.make(relative),
                  type: "file",
                }),
                line: match.line_number,
                offset: match.absolute_offset,
                text:
                  match.lines.text.length > 2_000
                    ? match.lines.text.slice(0, 2_000).replace(/[\uD800-\uDBFF]$/, "") + "..."
                    : match.lines.text,
                submatches: match.submatches.map((submatch) => ({
                  text: submatch.match.text,
                  start: submatch.start,
                  end: submatch.end,
                })),
              })
            }),
          ),
        ),
      search: (input) => {
        const mode = input.mode ?? "content"
        if (mode !== "content") {
          return run<string | GrepCount>({
            cwd: input.cwd,
            limit: input.limit,
            offset: input.offset,
            signal: input.signal,
            pattern: input.pattern,
            args: [
              "--no-config",
              "--hidden",
              "--no-messages",
              ...(input.include ? [`--glob=${input.include}`] : []),
              "--glob=!**/.git/**",
              ...(input.insensitive ? ["-i"] : []),
              mode === "files_with_matches" ? "--files-with-matches" : "--count-matches",
              "--",
              input.pattern,
              input.file ?? ".",
            ],
            parse: (line) => {
              if (mode === "files_with_matches") return Effect.succeed(normalizeEntryPath(line))
              // A single-file target prints a bare count without the path prefix.
              const bare = /^(\d+)$/u.exec(line)
              if (bare && input.file) return Effect.succeed({ path: input.file, count: Number(bare[1]) })
              const index = line.lastIndexOf(":")
              if (index === -1) return Effect.fail(failure(`Invalid ripgrep count output: ${line}`))
              return Effect.succeed({
                path: normalizeEntryPath(line.slice(0, index)),
                count: Number(line.slice(index + 1)),
              })
            },
          }).pipe(
            Effect.map((result) =>
              mode === "files_with_matches"
                ? {
                    mode,
                    files: result.items as readonly string[],
                    total: result.items.length,
                    hasMore: result.truncated,
                  }
                : {
                    mode,
                    counts: result.items as readonly GrepCount[],
                    total: result.items.length,
                    hasMore: result.truncated,
                  },
            ),
          )
        }

        // Content mode. Context records (type:"context", emitted for -A/-B/-C)
        // ride with their match group; offset/limit count MATCH records — context
        // rows are never counted or split across the window boundary.
        const before = input.before ?? 0
        const after = input.after ?? 0
        const contextLines = before + after
        const wanted = input.offset ?? 0
        // Row budget: each match emits itself plus at most `contextLines`
        // context records; the margin absorbs rg's cross-group context
        // de-duplication so the bound never cuts inside the match window.
        const rowLimit = contextLines > 0 ? (wanted + input.limit) * (2 + contextLines) + 64 : wanted + input.limit + 1

        return run<RawRow>({
          cwd: input.cwd,
          limit: rowLimit,
          signal: input.signal,
          pattern: input.pattern,
          args: [
            "--no-config",
            "--json",
            "--hidden",
            "--no-messages",
            ...(input.include ? [`--glob=${input.include}`] : []),
            "--glob=!**/.git/**",
            ...(input.insensitive ? ["-i"] : []),
            ...(before > 0 ? ["-B", String(before)] : []),
            ...(after > 0 ? ["-A", String(after)] : []),
            "--",
            input.pattern,
            input.file ?? ".",
          ],
          parse: (line) =>
            (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES
              ? Effect.fail(failure(`Ripgrep JSON record exceeded ${MAX_RECORD_BYTES} bytes`))
              : Effect.try({
                  try: () => JSON.parse(line) as unknown,
                  catch: (cause) => failure("Invalid ripgrep JSON output", cause),
                })
            ).pipe(
              Effect.flatMap((json) => {
                if (
                  !json ||
                  typeof json !== "object" ||
                  !("type" in json) ||
                  (json.type !== "match" && json.type !== "context")
                )
                  return Effect.succeed(undefined)
                return Schema.decodeUnknownEffect(RawMatch)(json).pipe(
                  Effect.map((match) => ({
                    path: { text: match.data.path.text.replace(/^\.[\\/]/, "") },
                    line_number: match.data.line_number,
                    absolute_offset: match.data.absolute_offset,
                    lines: match.data.lines,
                    submatches: match.data.submatches.slice(0, MAX_SUBMATCHES),
                    context: match.type === "context",
                  })),
                  Effect.mapError((cause) => failure("Invalid ripgrep match output", cause)),
                )
              }),
            ),
        }).pipe(
          Effect.map((result) => {
            // Window by MATCH records: leading context records are held until
            // their match is admitted; the first match beyond the window ends
            // the walk and its leading context is dropped (rg de-duplicates
            // shared context lines, so at most one side of the boundary loses
            // context — matches themselves are never lost).
            const page: RawRow[] = []
            let seen = 0
            let hasMore = false
            let pending: RawRow[] = []
            for (const row of result.items) {
              if (row.context) {
                pending.push(row)
                continue
              }
              seen += 1
              if (seen > wanted + input.limit) {
                hasMore = true
                break
              }
              if (seen > wanted) page.push(...pending, row)
              pending = []
            }
            if (!hasMore) page.push(...pending)

            const rows = page.map((row) => ({
              path: normalizeEntryPath(row.path.text),
              line: row.line_number,
              text:
                row.lines.text.length > 2_000
                  ? row.lines.text.slice(0, 2_000).replace(/[\uD800-\uDBFF]$/, "") + "..."
                  : row.lines.text,
              context: row.context,
            }))
            return { mode: "content" as const, rows, total: seen, hasMore }
          }),
        )
      }
    })
  }),
)

const normalizeEntryPath = (line: string) =>
  line.replace(/^(?:\.[\\/])+/u, "").replace(/^[\\/]+/u, "").replaceAll("\\", "/")

type RawRow = {
  path: { text: string }
  line_number: number
  absolute_offset: number
  lines: { text: string }
  submatches: readonly unknown[]
  context: boolean
}

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [RipgrepBinary.node, AppProcess.node] })
