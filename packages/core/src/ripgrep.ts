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

/**
 * Oversized JSON records (default JSON limiter, 64 KiB): a MATCH line this
 * large fails the whole search — an invisible match is worse than an error —
 * but an oversized CONTEXT line is auxiliary decoration around fine match
 * lines, so it is dropped and the page keeps its matches instead of failing.
 */
const oversizedRecord = (line: string): Effect.Effect<boolean, Error> => {
  if (Buffer.byteLength(line, "utf8") <= MAX_RECORD_BYTES) return Effect.succeed(false)
  if (/"type":"context"/.test(line)) return Effect.succeed(true)
  return Effect.fail(failure(`Ripgrep JSON record exceeded ${MAX_RECORD_BYTES} bytes`))
}

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

/** total counts observed entries. With hasMore it is a lower bound, and at EOF it is exact. */
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
      readonly consume?: (item: A) => boolean
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
          // Step P7: count the skipped prefix without storing its rows.
          const rows: A[] = []
          let truncated = false
          yield* Stream.decodeText(handle.stdout).pipe(
            Stream.splitLines,
            Stream.filter((line) => line.length > 0),
            Stream.mapEffect(input.parse),
            Stream.filter((row): row is A => row !== undefined),
            Stream.tap((row) => {
              observed++
              if (input.consume) {
                truncated = input.consume(row)
                return Effect.void
              }
              if (observed > offset + input.limit) {
                truncated = true
                return Effect.void
              }
              if (observed > offset) rows.push(row)
              return input.onItem?.(row) ?? Effect.void
            }),
            Stream.takeUntil(() => truncated),
            Stream.runDrain,
          )
          const total = observed
          if (truncated) return { items: rows, total, truncated, partial: false }

          const code = yield* handle.exitCode
          const stderr = yield* Fiber.join(stderrFiber)
          if (input.pattern && code === 2 && isInvalidPattern(stderr)) {
            return yield* new InvalidPatternError({ pattern: input.pattern, message: stderr.trim() })
          }
          if (code !== 0 && code !== 1 && code !== 2) {
            return yield* failure(stderr.trim() || `ripgrep failed with code ${code}`)
          }
          return { items: rows, total, truncated: false, partial: code === 2 }
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
          parse: (line) => Effect.succeed(normalizeEntryPath(line)),
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
            return Effect.succeed(
              Entry.make({
                path: RelativePath.make(normalizeEntryPath(line)),
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
            oversizedRecord(line).pipe(
              Effect.flatMap((dropped) =>
                dropped
                  ? Effect.succeed(undefined)
                  : Effect.try({
                      try: () => JSON.parse(line) as unknown,
                      catch: (cause) => failure("Invalid ripgrep JSON output", cause),
                    }),
              ),
            ).pipe(
              Effect.flatMap((json) => {
                if (!json || typeof json !== "object" || !("type" in json) || json.type !== "match")
                  return Effect.succeed(undefined)
                return Schema.decodeUnknownEffect(RawMatch)(json).pipe(
                  Effect.map((match) => ({
                    ...match.data,
                    submatches: match.data.submatches.slice(0, MAX_SUBMATCHES),
                  })),
                  Effect.mapError((cause) => failure("Invalid ripgrep match output", cause)),
                )
              }),
            ),
        }).pipe(
          Effect.map((result) =>
            result.items.map((match) => {
              return Match.make({
                entry: Entry.make({
                  path: RelativePath.make(normalizeEntryPath(match.path.text)),
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
              // Paginated modes need cross-invocation order stability: rg's
              // default walk order varies run to run, which duplicates and
              // drops rows between offset pages. --sort=path forces a
              // deterministic order (at the cost of the parallel walk — the
              // row budget already bounds the work).
              "--sort=path",
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
              if (bare && input.file) return Effect.succeed({ path: normalizeEntryPath(input.file), count: Number(bare[1]) })
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
                    total: result.total,
                    hasMore: result.truncated,
                  }
                : {
                    mode,
                    counts: result.items as readonly GrepCount[],
                    total: result.total,
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
        // Step P8: select context by file and line relative to admitted matches.
        const page = contentPage(input.offset ?? 0, input.limit, before, after)
        return run<RawRow>({
          cwd: input.cwd,
          limit: input.limit,
          consume: page.add,
          signal: input.signal,
          pattern: input.pattern,
          args: [
            "--no-config",
            "--json",
            "--hidden",
            "--no-messages",
            // Same cross-invocation stability as the non-content modes:
            // offset windows must traverse an identical sequence on every
            // page, and rg's default walk order is not stable.
            "--sort=path",
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
            oversizedRecord(line).pipe(
              Effect.flatMap((dropped) =>
                dropped
                  ? Effect.succeed(undefined)
                  : Effect.try({
                      try: () => JSON.parse(line) as unknown,
                      catch: (cause) => failure("Invalid ripgrep JSON output", cause),
                    }),
              ),
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
                    path: match.data.path,
                    line_number: match.data.line_number,
                    absolute_offset: match.data.absolute_offset,
                    lines: match.data.lines,
                    submatches: match.data.submatches.slice(0, MAX_SUBMATCHES),
                    context: match.type === "context",
                  })),
                  Effect.catch((cause) => json.type === "context" ? Effect.succeed(undefined) : Effect.fail(failure("Invalid ripgrep match output", cause))),
                )
              }),
            ),
        }).pipe(
          Effect.map(() => page.result()),
        )
      }
    })
  }),
)

// Keep only the requested page, plus at most "before" rows of lookbehind.
function contentPage(offset: number, limit: number, before: number, after: number) {
  const rows: GrepRow[] = []
  let pending: GrepRow[] = []
  let last: GrepRow | undefined
  let seen = 0
  let hasMore = false
  return {
    add(raw: RawRow) {
      const row = {
        path: normalizeEntryPath(raw.path.text),
        line: raw.line_number,
        text:
          raw.lines.text.length > 2000
            ? raw.lines.text.slice(0, 2000).replace(/[\uD800-\uDBFF]$/, "") + "..."
            : raw.lines.text,
        context: raw.context,
      }
      const following = last?.path === row.path && row.line <= last.line + after
      if (hasMore && !following) return true
      if (row.context) {
        if (following) rows.push(row)
        else if (before > 0 && !hasMore) {
          if (pending.at(-1)?.path !== row.path) pending = []
          pending.push(row)
          if (pending.length > before) pending.shift()
        }
        return false
      }
      if (!hasMore) seen++
      if (seen > offset + limit) {
        hasMore = true
        return !following || row.line === last!.line + after
      }
      if (seen > offset) {
        for (const previous of pending)
          if (previous.path === row.path && previous.line >= row.line - before) rows.push(previous)
        rows.push(row)
        last = row
      }
      if (seen > offset) pending = []
      return false
    },
    result: () => ({ mode: "content" as const, rows, total: seen, hasMore }),
  }
}

export function windowContentRows(rows: readonly RawRow[], offset: number, limit: number, before = 10, after = 0) {
  const page = contentPage(offset, limit, before, after)
  for (const row of rows) if (page.add(row)) break
  return page.result()
}

// A backslash is an ordinary filename character on POSIX.
function normalizeEntryPath(line: string) {
  const native = process.platform === "win32" ? line.replaceAll("\\", "/") : line
  return native.replace(/^(?:\.\/)+/u, "").replace(/^\/+/, "")
}

export type RawRow = {
  path: { text: string }
  line_number: number
  absolute_offset: number
  lines: { text: string }
  submatches: readonly unknown[]
  context: boolean
}

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [RipgrepBinary.node, AppProcess.node] })
