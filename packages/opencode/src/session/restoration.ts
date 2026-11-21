import path from "node:path"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { InstanceState } from "@/effect/instance-state"
import { containsPath } from "@/project/instance-context"
import { MessageV2 } from "./message-v2"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Cause, Effect, Exit, Option } from "effect"
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

export function isRestoration(part: SessionV1.Part): boolean {
  return (
    part.type === "text" &&
    part.synthetic === true &&
    (part.metadata?.kind === "compaction_restoration" || part.text.startsWith(RESTORATION_SENTINEL))
  )
}

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

/** Latest complete read in the retained model history, identified by its file and exact bytes. */
export function retainedFileVersions(messages: SessionV1.WithParts[]) {
  const versions = new Map<string, string>()
  for (const msg of messages) {
    if (msg.info.role !== "assistant" || !MessageV2.assistantVisible(msg)) continue
    for (const part of msg.parts) {
      if (part.type !== "tool" || part.state.status !== "completed" || part.state.time.compacted) continue
      const metadata = part.state.metadata
      if (part.tool === "edit" && typeof metadata.filediff?.file === "string") versions.delete(metadata.filediff.file)
      const display = metadata.display
      if (part.tool !== "read" || display?.type !== "file" || typeof display.path !== "string") continue
      versions.delete(display.path)
      if (
        metadata.truncated ||
        display.truncated ||
        display.lineStart !== 1 ||
        display.lineEnd !== display.totalLines ||
        typeof display.sha256 !== "string" ||
        typeof display.text !== "string"
      )
        continue
      // A plugin may rewrite the tool output independently of its display metadata.
      const shown =
        display.totalLines === 0
          ? "(End of file - total 0 lines)"
          : display.text
              .split("\n")
              .map((line: string, index: number) => `${index + 1}: ${line}`)
              .join("\n")
      if (("\n" + part.state.output + "\n").includes("\n" + shown + "\n")) versions.set(display.path, display.sha256)
    }
  }
  return versions
}

export function collectCandidates(
  messages: SessionV1.WithParts[],
  todos: Todo.Info[] | undefined,
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
  const todo = !todos || todos.length > 0 ? [{ kind: "todo" as const, ref: "todo", lastUseSeq: seq + 1 }] : []
  return [...todo, ...candidates]
}

export function materializeCandidates(
  candidates: RestorationCandidate[],
  versions: ReadonlyMap<string, string>,
  deps: {
    fs: FSUtil.Interface
    readable?: (path: string) => boolean
    skill: Option.Option<Skill.Interface>
    todos: Todo.Info[] | undefined
    cfg: RestorationConfig
  },
): Effect.Effect<RestorationMaterial[]> {
  const budget = inlineBudget(deps.cfg)
  const include = (candidate: RestorationCandidate, content: string): RestorationMaterial =>
    budget.admit(candidate, content)
      ? { candidate, status: "inlined", content }
      : { candidate, status: "reference", reason: "restoration budget exhausted" }
  return Effect.forEach(candidates, (candidate) =>
    Effect.gen(function* () {
      if (candidate.kind === "todo" && !deps.todos) {
        return { candidate, status: "missing" as const, reason: "todo list unavailable" }
      }
      if (budget.exhausted()) {
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
        return include(candidate, content)
      }
      if (candidate.kind === "skill") {
        if (Option.isNone(deps.skill)) {
          return { candidate, status: "missing" as const, reason: "skill service unavailable" }
        }
        const info = yield* deps.skill.value.get(candidate.ref).pipe(Effect.option)
        if (Option.isNone(info) || info.value === undefined) {
          return { candidate, status: "missing" as const, reason: `skill "${candidate.ref}" not found` }
        }
        const content =
          info.value.location === "<built-in>"
            ? info.value.content
            : yield* deps.fs.readFileStringSafe(info.value.location)
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
        return include(candidate, content)
      }
      if (budget.fileLimit())
        return { candidate, status: "reference" as const, reason: `beyond max_files=${deps.cfg.max_files}` }
      if (deps.readable && !deps.readable(candidate.ref))
        return { candidate, status: "reference" as const, reason: "read permission required" }
      const resolved = yield* Effect.try({
        try: () => FSUtil.resolve(candidate.ref),
        catch: () => new Error("path unavailable"),
      }).pipe(Effect.option)
      if (Option.isNone(resolved)) return { candidate, status: "missing" as const, reason: "path unavailable" }
      if (deps.readable && !deps.readable(resolved.value))
        return { candidate, status: "reference" as const, reason: "read permission required" }
      const stat = yield* deps.fs.stat(resolved.value).pipe(Effect.option)
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
      const bytes = yield* deps.fs.readFile(resolved.value).pipe(Effect.option)
      if (Option.isNone(bytes)) {
        return { candidate, status: "missing" as const, reason: `file unreadable: ${candidate.ref}` }
      }
      const content = new TextDecoder().decode(bytes.value)
      if (Token.estimate(content) > deps.cfg.file_max_tokens) {
        return {
          candidate,
          status: "reference" as const,
          reason: `file is ~${Token.estimate(content)} tokens (over the ${deps.cfg.file_max_tokens} cap); read it with the read tool if needed`,
        }
      }
      const version = versions.get(candidate.ref)
      if (version && Bun.SHA256.hash(bytes.value, "hex") === version) {
        return { candidate, status: "skipped-duplicate" as const, reason: "already intact in the retained tail" }
      }
      return include(candidate, content)
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

const HEADER = RESTORATION_SENTINEL + "\nContext restored from before the last compaction:"
const SECTION = { file: "## Files", skill: "## Skills", todo: "## Todos" }
const clipRef = (ref: string) =>
  ref.length > MAX_REF_CHARS ? ref.slice(0, MAX_REF_CHARS).replace(/[\uD800-\uDBFF]$/u, "") + "…" : ref

// Charge the actual markdown in code units, including every separating newline. The
// token estimator rounds length / 4; using at most 4 * budget units is conservative.
function inlineBudget(cfg: RestorationConfig) {
  const seen = new Set<RestorationCandidate["kind"]>()
  let remaining = cfg.budget_tokens * TOKEN_BYTES - HEADER.length
  let files = 0
  return {
    exhausted: () => remaining <= 0,
    fileLimit: () => files >= cfg.max_files,
    admit(candidate: RestorationCandidate, content: string) {
      const kind = candidate.kind
      const block = `### ${clipRef(candidate.ref)}\n\`\`\`\n${content}\n\`\`\``
      const cost = block.length + 1 + (seen.has(kind) ? 0 : SECTION[kind].length + 1)
      if (cost > remaining) return
      remaining -= cost
      seen.add(kind)
      if (kind === "file") files++
      return block
    },
  }
}

export function renderMaterials(materials: RestorationMaterial[], cfg: RestorationConfig): string | undefined {
  // budget_tokens: 0 means "restore nothing" — without this gate, content
  // whose rounded token estimate is 0 (1–2 chars) would still inline "for
  // free" past an explicitly zeroed budget.
  if (cfg.budget_tokens <= 0) return undefined
  const sectionsByKind: Record<"file" | "skill" | "todo", string[]> = { file: [], skill: [], todo: [] }
  const lines: string[] = []
  let overflowLines = 0
  const budget = inlineBudget(cfg)

  const referenceLine = (material: RestorationMaterial) => {
    const reason = material.reason ?? material.status
    return `- ${clipRef(material.candidate.ref)} (${clipRef(reason)})`
  }
  const pushLine = (line: string) => {
    if (lines.length >= MAX_REFERENCE_LINES) {
      overflowLines += 1
      return
    }
    lines.push(line)
  }

  for (const material of materials) {
    const kind = material.candidate.kind
    if (material.status === "inlined") {
      if (kind === "file" && budget.fileLimit()) {
        pushLine(
          `- ${clipRef(material.candidate.ref)} (beyond max_files=${cfg.max_files}; read it with the read tool if needed)`,
        )
        continue
      }
      const block = budget.admit(material.candidate, material.content ?? "")
      if (!block) {
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
      sectionsByKind[kind].push(block)
      continue
    }
    if (material.status === "skipped-duplicate") continue
    pushLine(referenceLine(material))
  }

  const sections = (["file", "skill", "todo"] as const).flatMap((kind) =>
    sectionsByKind[kind].length > 0 ? [SECTION[kind], ...sectionsByKind[kind]] : [],
  )
  if (sections.length === 0 && lines.length === 0) return undefined

  const inline = [HEADER, ...sections].join("\n")
  if (lines.length === 0) return inline
  const allowance = Math.max(128, Math.min(2000, cfg.budget_tokens))
  const available = (cfg.budget_tokens + allowance) * TOKEN_BYTES - inline.length
  for (;;) {
    const diagnostics = [
      "",
      "## Not restored",
      ...lines,
      ...(overflowLines > 0 ? [`- ...and ${overflowLines} more (use the read/glob tools if needed)`] : []),
    ].join("\n")
    if (diagnostics.length <= available || lines.length === 0) return inline + diagnostics
    lines.pop()
    overflowLines++
  }
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

  // Step P2: full message read → locate the settled compaction marker
  // and any existing sentinel.
  const messages = yield* sessions.messages({ sessionID })

  let compactionIdx = -1
  let restorationIdx = -1
  let restoredMarker: unknown
  // A marker counts as settled only when a completed summary points at it
  // (#77): summary && finish && !error, parentID = the marker's message —
  // the same predicate filterCompacted uses. This covers both settled shapes:
  // a summary with retained originals and
  // a full-summary fallback (n = 0 because there is no tail
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
      }
      // Retired (ignored) blocks do not count as "already restored" — a
      // transcript whose only sentinels are ignored must re-fire.
      if (part.type === "text" && isRestoration(part) && !part.ignored) {
        restorationIdx = index
        restoredMarker = part.metadata?.markerID
      }
    }
  })
  // Step P3: trigger decision — no compaction, or a sentinel already newer
  // than the compaction → leave the transcript alone.
  if (compactionIdx === -1) return
  if (restoredMarker ? restoredMarker === messages[compactionIdx]!.info.id : restorationIdx > compactionIdx) return

  const userMessage = messages.findLast((msg) => msg.info.role === "user")
  if (userMessage?.info.role !== "user") return

  const todos = Option.isSome(todoOpt)
    ? yield* todoOpt.value.get(sessionID).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          () => Effect.succeed(undefined),
        ),
      )
    : []

  // Step P4/P5: collect candidates (B5: read only display.type === "file";
  // edit via filediff.file; skill via name; most-recent-first; todo appended),
  // then materialize (stat File-guard → byte/token caps → disk read →
  // compare complete retained versions, then apply the rendered budget).
  const current = yield* sessions.get(sessionID)
  const agents = yield* Agent.Service
  const agent = yield* agents.get(userMessage.info.agent)
  const selectedAgent =
    current.agent && current.agent !== userMessage.info.agent ? yield* agents.get(current.agent) : agent
  const instance = yield* InstanceState.context
  const rules = Permission.merge(agent?.permission ?? [], current.permission ?? [])
  const selectedRules = Permission.merge(selectedAgent?.permission ?? [], current.permission ?? [])
  const tools = userMessage.info.tools
  const allowed = (permission: string, pattern: string) =>
    !!agent &&
    !!selectedAgent &&
    tools?.[permission] !== false &&
    Permission.evaluate(permission, pattern, rules).action === "allow" &&
    Permission.evaluate(permission, pattern, selectedRules).action === "allow"
  const readable = (file: string) =>
    allowed("read", path.relative(instance.worktree, file)) &&
    (containsPath(file, instance) ||
      allowed("external_directory", FSUtil.normalizePathPattern(path.join(path.dirname(file), "*"))))
  const candidates = collectCandidates(messages, todos).filter((c) => c.kind !== "skill" || allowed("skill", c.ref))
  const projected = MessageV2.filterCompacted(messages.toReversed())
  const versions = retainedFileVersions(projected.slice(2))
  const materials = yield* materializeCandidates(candidates, versions, { fs, skill: skillOpt, todos, cfg, readable })
  // Step P6: render within budget (max_files per file, exhaustion degrades to
  // bounded reference lines) into sentinel + Files/Skills/Todos + Not restored.
  const text = renderMaterials(materials, cfg)

  // Step P7: byte-identical comparison against the previous sentinel — only a
  // changed block is persisted. An ignored sentinel is not "the previous
  // block"; it is retired history (see G4 retirement below), so a re-fire
  // after retirement still writes.
  const previous = userMessage.parts.findLast(
    (part): part is SessionV1.TextPart => part.type === "text" && isRestoration(part) && !part.ignored,
  )
  if (text && previous?.text === text && previous.metadata?.markerID === messages[compactionIdx]!.info.id) return

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
      if (part.type !== "text" || part.ignored || !isRestoration(part)) continue
      yield* sessions.updatePart({ ...part, ignored: true })
    }
  }

  if (!text) return
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text,
    metadata: { kind: "compaction_restoration", markerID: messages[compactionIdx]!.info.id },
    synthetic: true,
  })
  userMessage.parts.push(part)
})

export * as SessionRestoration from "./restoration"
