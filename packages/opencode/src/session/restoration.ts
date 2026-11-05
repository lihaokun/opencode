import { SessionV1 } from "@opencode-ai/core/v1/session"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Exit, Option } from "effect"
import { Config } from "@/config/config"
import { Skill } from "@/skill"
import { Todo } from "./todo"
import { Token } from "@/util/token"
import { PartID, SessionID } from "./schema"
import { Session } from "./session"

/**
 * Post-compaction restoration: after a compaction, re-supply within budget the
 * state a task needs to continue — the current on-disk versions of files this
 * session read or edited, loaded skill bodies, and the current todo list.
 *
 * Mirrors the roster design (session/reminders.ts): edge-triggered at a turn
 * boundary, written once to the transcript as a synthetic part on the last
 * user message, deduplicated byte-for-byte, and located after the compaction's
 * tail so filterCompacted keeps it visible.
 */

export const RESTORATION_SENTINEL = "<!-- opencode:restoration -->"

export type RestorationCandidate = {
  kind: "file" | "skill" | "todo"
  ref: string
  lastUseSeq: number
}

export type RestorationStatus = "inlined" | "reference" | "skipped-duplicate" | "skipped-budget" | "missing"

export type RestorationMaterial = {
  candidate: RestorationCandidate
  status: RestorationStatus
  content?: string
  reason?: string
}

export type RestorationConfig = {
  enabled: boolean
  max_files: number
  file_max_tokens: number
  budget_tokens: number
}

const DEFAULTS: RestorationConfig = {
  enabled: true,
  max_files: 5,
  file_max_tokens: 4_000,
  budget_tokens: 8_000,
}

const TOKEN_BYTES = 4

export function restorationConfig(config: ConfigV1Lite | undefined): RestorationConfig {
  const r = config?.compaction?.restoration
  return {
    enabled: r?.enabled ?? DEFAULTS.enabled,
    max_files: r?.max_files ?? DEFAULTS.max_files,
    file_max_tokens: r?.file_max_tokens ?? DEFAULTS.file_max_tokens,
    budget_tokens: r?.budget_tokens ?? DEFAULTS.budget_tokens,
  }
}

type ConfigV1Lite = {
  compaction?: {
    restoration?: {
      enabled?: boolean
      max_files?: number
      file_max_tokens?: number
      budget_tokens?: number
    }
  }
}

/**
 * Text of everything filterCompacted still shows verbatim: the dedup baseline.
 * Mirrors the model projection (message-v2.ts completed branch): a part with
 * `time.compacted` renders as "[Old tool result content cleared]", so its
 * stored output is NOT model-visible and must not enter the baseline —
 * matching against it would wrongly mark files as still-present (R3).
 */
export function buildTailText(messages: SessionV1.WithParts[], tailStartID: string | undefined): string {
  if (!tailStartID) return ""
  const index = messages.findIndex((msg) => msg.info.id === tailStartID)
  if (index === -1) return ""
  const parts: string[] = []
  for (const msg of messages.slice(index)) {
    for (const part of msg.parts) {
      if (part.type === "text") parts.push(part.text)
      else if (
        part.type === "tool" &&
        part.state.status === "completed" &&
        !part.state.time?.compacted
      )
        parts.push(part.state.output)
    }
  }
  return parts.join("\n\n")
}

export function collectCandidates(
  messages: SessionV1.WithParts[],
  todos: Todo.Info[],
): RestorationCandidate[] {
  const byRef = new Map<string, RestorationCandidate>()
  let seq = 0
  for (const msg of messages) {
    for (const part of msg.parts) {
      seq += 1
      if (part.type !== "tool" || part.state.status !== "completed") continue
      const touch = (kind: RestorationCandidate["kind"], ref: string | undefined) => {
        if (!ref) return
        byRef.set(`${kind}\0${ref}`, { kind, ref, lastUseSeq: seq })
      }
      // Read metadata is a free-form record; the display projection is the
      // read tool's own contract (tool/read.ts). Directory reads carry the
      // same display.path with type "directory" — restoring a directory
      // listing is noise, only files are re-inlined. Edit parts carry the
      // path in the filediff record (metadata.filepath is the permission
      // request's shape, not the result's).
      const meta = part.state.metadata as {
        display?: { type?: string; path?: string }
        filediff?: { file?: string }
        name?: string
      }
      if (part.tool === "read") {
        if (meta.display?.type === "file") touch("file", meta.display.path)
      } else if (part.tool === "edit") touch("file", meta.filediff?.file)
      else if (part.tool === "skill") touch("skill", meta.name)
    }
  }
  const candidates = [...byRef.values()].toSorted((a, b) => b.lastUseSeq - a.lastUseSeq)
  // The todo list rides at the TOP of the sort, not the bottom: its
  // lastUseSeq (seq + 1) makes it the most recent candidate, and it is the
  // smallest material by far. Appending it after the sort processed it LAST,
  // so any budget pressure degraded the whole current todo list to a
  // reference line — the cheapest item paid first.
  const todo = todos.length > 0 ? [{ kind: "todo" as const, ref: "todo", lastUseSeq: seq + 1 }] : []
  return [...todo, ...candidates]
}

export function materializeCandidates(
  candidates: RestorationCandidate[],
  tailText: string,
  deps: {
    fs: FSUtil.Interface
    skill: Option.Option<Skill.Interface>
    todos: Todo.Info[]
    cfg: RestorationConfig
  },
): Effect.Effect<RestorationMaterial[]> {
  // R4: stop reading once inlined content has consumed the budget — later
  // candidates can only become reference lines, and stat/read-ing every
  // historical file just to render "- path (skipped: …)" wastes IO on
  // thousand-file histories. Candidates are ordered most-recent-first, so the
  // dropped tail is the stalest material.
  let spent = 0
  return Effect.forEach(
    candidates,
    (candidate) =>
      Effect.gen(function* () {
        if (spent >= deps.cfg.budget_tokens) {
          // Kind-specific honest guidance: skills and files are reloadable
          // with their tools, but there is no todo-reading tool — pointing
          // the model at "the read tool" for a todo list is a dead end.
          return {
            candidate,
            status: "reference" as const,
            reason:
              candidate.kind === "todo"
                ? "restoration budget exhausted; the todo list was not re-inlined"
                : "restoration budget exhausted",
          }
        }
        if (candidate.kind === "todo") {
          const content = JSON.stringify(deps.todos, null, 2)
          spent += Token.estimate(content)
          return { candidate, status: "inlined" as const, content }
        }
        if (candidate.kind === "skill") {
          if (Option.isNone(deps.skill)) {
            return { candidate, status: "missing" as const, reason: "skill service unavailable" }
          }
          const info = yield* deps.skill.value.get(candidate.ref).pipe(Effect.option)
          if (Option.isNone(info) || info.value === undefined) {
            return { candidate, status: "missing" as const, reason: `skill "${candidate.ref}" not found` }
          }
          const content = yield* deps.fs.readFileStringSafe(info.value.location)
          if (content === undefined) {
            return { candidate, status: "missing" as const, reason: `skill file missing: ${info.value.location}` }
          }
          if (Token.estimate(content) > deps.cfg.file_max_tokens) {
            return {
              candidate,
              status: "reference" as const,
              reason: `skill body is ${Token.estimate(content)} tokens (over the ${deps.cfg.file_max_tokens} cap); reload it with the skill tool if needed`,
            }
          }
          spent += Token.estimate(content)
          return { candidate, status: "inlined" as const, content }
        }
        const stat = yield* deps.fs.stat(candidate.ref).pipe(Effect.option)
        if (Option.isNone(stat) || stat.value.type !== "File") {
          return { candidate, status: "missing" as const, reason: `file not found on disk: ${candidate.ref}` }
        }
        if (stat.value.size > deps.cfg.file_max_tokens * TOKEN_BYTES) {
          return {
            candidate,
            status: "reference" as const,
            reason: `file is ${stat.value.size} bytes (over the ${deps.cfg.file_max_tokens} token cap); read it with the read tool if needed`,
          }
        }
        const content = yield* deps.fs.readFileStringSafe(candidate.ref)
        if (content === undefined) {
          return { candidate, status: "missing" as const, reason: `file unreadable: ${candidate.ref}` }
        }
        if (Token.estimate(content) > deps.cfg.file_max_tokens) {
          return {
            candidate,
            status: "reference" as const,
            reason: `file is ~${Token.estimate(content)} tokens (over the ${deps.cfg.file_max_tokens} cap); read it with the read tool if needed`,
          }
        }
        if (tailText.includes(content)) {
          return { candidate, status: "skipped-duplicate" as const, reason: "already intact in the retained tail" }
        }
        spent += Token.estimate(content)
        return { candidate, status: "inlined" as const, content }
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            candidate,
            status: "missing" as const,
            reason: `restoration read failed: ${String(error)}`,
          }),
        ),
      ),
  )
}

/**
 * Cap on the "Not restored" reference lines: the omitted list is explanatory,
 * not payload, so it collapses to a single bounded summary line beyond this
 * many entries (R4 — unbounded reference text broke the budget contract).
 * MAX_REF_CHARS additionally caps each line's ref segment: refs are raw
 * absolute paths (Linux PATH_MAX 4096), so a count cap alone still admits
 * ~20 × 4 KiB ≈ 21k tokens against the default 8000 budget.
 */
const MAX_REFERENCE_LINES = 20
const MAX_REF_CHARS = 160

export function renderMaterials(materials: RestorationMaterial[], cfg: RestorationConfig): string | undefined {
  // budget_tokens: 0 means "restore nothing" — without this gate, content
  // whose rounded token estimate is 0 (1–2 chars) would still inline "for
  // free" past an explicitly zeroed budget.
  if (cfg.budget_tokens <= 0) return undefined
  const sectionsByKind: Record<"file" | "skill" | "todo", string[]> = { file: [], skill: [], todo: [] }
  const lines: string[] = []
  let overflowLines = 0
  let used = 0
  let fileCount = 0
  let overBudget = false

  const referenceLine = (material: RestorationMaterial) => {
    const reason = material.reason ?? material.status
    return `- ${clipRef(material.candidate.ref)} (${reason})`
  }
  const pushLine = (line: string) => {
    if (lines.length >= MAX_REFERENCE_LINES) {
      overflowLines += 1
      return
    }
    lines.push(line)
  }

  // Both ends of every reference line are attacker-sized (paths up to
  // PATH_MAX, reasons with guidance prose): clip the ref so 20 lines can
  // never blow the budget on their own.
  const clipRef = (ref: string) => (ref.length > MAX_REF_CHARS ? ref.slice(0, MAX_REF_CHARS) + "…" : ref)

  for (const material of materials) {
    const kind = material.candidate.kind
    if (material.status === "inlined") {
      if (kind === "file" && fileCount >= cfg.max_files) {
        pushLine(`- ${clipRef(material.candidate.ref)} (beyond max_files=${cfg.max_files}; read it with the read tool if needed)`)
        continue
      }
      const cost = Token.estimate(material.content ?? "")
      if (overBudget || used + cost > cfg.budget_tokens) {
        overBudget = true
        pushLine(
          `- ${clipRef(material.candidate.ref)} (skipped: restoration budget exhausted; ${
            kind === "file"
              ? "read it with the read tool if needed"
              : kind === "skill"
                ? "reload it with the skill tool if needed"
                : "the todo list was not re-inlined"
          })`,
        )
        continue
      }
      used += cost
      if (kind === "file") fileCount += 1
      sectionsByKind[kind].push(`### ${clipRef(material.candidate.ref)}\n\`\`\`\n${material.content}\n\`\`\``)
      continue
    }
    if (material.status === "skipped-duplicate") continue
    pushLine(referenceLine(material))
  }

  const sections = (["file", "skill", "todo"] as const).flatMap((kind) =>
    sectionsByKind[kind].length > 0 ? [kind === "file" ? "## Files" : kind === "skill" ? "## Skills" : "## Todos", ...sectionsByKind[kind]] : [],
  )
  if (sections.length === 0 && lines.length === 0) return undefined

  const notRestored = [
    ...(lines.length > 0 ? ["## Not restored", ...lines] : []),
    ...(overflowLines > 0 ? [`- ...and ${overflowLines} more (use the read/glob tools if needed)`] : []),
  ]
  return [RESTORATION_SENTINEL, "Context restored from before the last compaction:", ...sections, ...notRestored].join("\n")
}

export const apply = Effect.fn("SessionRestoration.apply")(function* (input: { sessionID: SessionID }) {
  const exit = yield* Effect.exit(restore(input.sessionID))
  if (Exit.isFailure(exit)) {
    yield* Effect.logWarning("session restoration skipped")
  }
})

const restore = Effect.fn("SessionRestoration.restore")(function* (sessionID: SessionID) {
  const sessions = yield* Session.Service
  const fs = yield* FSUtil.Service
  const configOpt = yield* Effect.serviceOption(Config.Service)
  const todoOpt = yield* Effect.serviceOption(Todo.Service)
  const skillOpt = yield* Effect.serviceOption(Skill.Service)

  const rawConfig = Option.isSome(configOpt)
    ? yield* configOpt.value.get().pipe(Effect.orElseSucceed(() => undefined))
    : undefined
  const cfg = restorationConfig(rawConfig as ConfigV1Lite | undefined)
  if (!cfg.enabled) return

  // Step P2: full message read → locate the compaction part (tail_start_id)
  // and any existing sentinel.
  const messages = yield* sessions.messages({ sessionID })

  let compactionIdx = -1
  let tailStartID: string | undefined
  let restorationIdx = -1
  // A marker counts as settled only when a completed summary points at it
  // (#77): summary && finish && !error, parentID = the marker's message —
  // the same predicate filterCompacted uses. This covers both settled shapes:
  // a tail-retaining compaction (tail_start_id set by compaction.process) and
  // a full-summary fallback (tail_start_id undefined because there is no tail
  // to retain). A marker whose summary is in flight, failed, or was parked on
  // a newer user message by a retry has no such assistant — restoring "before
  // that compaction" would stack the block on top of a full, un-compacted
  // history.
  const settledMarkers = new Set<string>()
  for (const msg of messages) {
    if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error) {
      settledMarkers.add(msg.info.parentID)
    }
  }
  messages.forEach((msg, index) => {
    for (const part of msg.parts) {
      if (part.type === "compaction" && settledMarkers.has(msg.info.id)) {
        compactionIdx = index
        tailStartID = part.tail_start_id
      }
      // Retired (ignored) blocks do not count as "already restored" — a
      // transcript whose only sentinels are ignored must re-fire.
      if (part.type === "text" && !part.ignored && part.text.startsWith(RESTORATION_SENTINEL))
        restorationIdx = index
    }
  })
  // Step P3: trigger decision — no compaction, or a sentinel already newer
  // than the compaction → leave the transcript alone.
  if (compactionIdx === -1) return
  if (restorationIdx > compactionIdx) return

  const userMessage = messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return

  const todos = Option.isSome(todoOpt)
    ? yield* todoOpt.value.get(sessionID).pipe(Effect.orElseSucceed(() => []))
    : []

  // Step P4/P5: collect candidates (B5: read only display.type === "file";
  // edit via filediff.file; skill via name; most-recent-first; todo appended),
  // then materialize (stat File-guard → byte/token caps → disk read →
  // tail-substring skip-duplicate, budget-aware early stop).
  const tailText = buildTailText(messages, tailStartID)
  const candidates = collectCandidates(messages, todos)
  const materials = yield* materializeCandidates(candidates, tailText, { fs, skill: skillOpt, todos, cfg })
  // Step P6: render within budget (max_files per file, exhaustion degrades to
  // bounded reference lines) into sentinel + Files/Skills/Todos + Not restored.
  const text = renderMaterials(materials, cfg)
  if (!text) return

  // Step P7: byte-identical comparison against the previous sentinel — only a
  // changed block is persisted. An ignored sentinel is not "the previous
  // block"; it is retired history (see G4 retirement below), so a re-fire
  // after retirement still writes.
  const previous = userMessage.parts.findLast(
    (part): part is SessionV1.TextPart =>
      part.type === "text" && !part.ignored && part.text.startsWith(RESTORATION_SENTINEL),
  )
  if (previous?.text === text) return

  // G4 ("at most one restoration block per context"): every prior sentinel —
  // on any message — is retired the moment a fresh one is written. Without
  // this, a second compaction whose retained tail still holds the first
  // block's carrier message would leave two full "Context restored" blocks
  // (each up to budget_tokens) model-visible at once, both claiming to be the
  // current restoration. Retirement reuses each part's own id: updatePart
  // upserts the same PartTable row (projector onConflictDoUpdate), so this is
  // an in-place flag flip, not an append — the transcript keeps the audit
  // trail while toModelMessagesEffect and the compaction serializer both skip
  // ignored text parts.
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== "text" || part.ignored || !part.text.startsWith(RESTORATION_SENTINEL)) continue
      if (previous?.id === part.id) continue
      yield* sessions.updatePart({ ...part, ignored: true })
    }
  }

  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text,
    synthetic: true,
  })
  userMessage.parts.push(part)
})

export * as SessionRestoration from "./restoration"
