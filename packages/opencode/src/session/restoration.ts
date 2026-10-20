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

/** Text of everything filterCompacted still shows verbatim: the dedup baseline. */
export function buildTailText(messages: SessionV1.WithParts[], tailStartID: string | undefined): string {
  if (!tailStartID) return ""
  const index = messages.findIndex((msg) => msg.info.id === tailStartID)
  if (index === -1) return ""
  const parts: string[] = []
  for (const msg of messages.slice(index)) {
    for (const part of msg.parts) {
      if (part.type === "text") parts.push(part.text)
      else if (part.type === "tool" && part.state.status === "completed") parts.push(part.state.output)
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
  if (todos.length > 0) candidates.push({ kind: "todo", ref: "todo", lastUseSeq: seq + 1 })
  return candidates
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
  return Effect.forEach(
    candidates,
    (candidate) =>
      Effect.gen(function* () {
        if (candidate.kind === "todo") {
          return { candidate, status: "inlined" as const, content: JSON.stringify(deps.todos, null, 2) }
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

export function renderMaterials(materials: RestorationMaterial[], cfg: RestorationConfig): string | undefined {
  const sectionsByKind: Record<"file" | "skill" | "todo", string[]> = { file: [], skill: [], todo: [] }
  const lines: string[] = []
  let used = 0
  let fileCount = 0
  let overBudget = false

  const referenceLine = (material: RestorationMaterial) => {
    const reason = material.reason ?? material.status
    return `- ${material.candidate.ref} (${reason})`
  }

  for (const material of materials) {
    const kind = material.candidate.kind
    if (material.status === "inlined") {
      if (kind === "file" && fileCount >= cfg.max_files) {
        lines.push(`- ${material.candidate.ref} (beyond max_files=${cfg.max_files}; read it with the read tool if needed)`)
        continue
      }
      const cost = Token.estimate(material.content ?? "")
      if (overBudget || used + cost > cfg.budget_tokens) {
        overBudget = true
        lines.push(
          `- ${material.candidate.ref} (skipped: restoration budget exhausted; read it with the read tool if needed)`,
        )
        continue
      }
      used += cost
      if (kind === "file") fileCount += 1
      sectionsByKind[kind].push(`### ${material.candidate.ref}\n\`\`\`\n${material.content}\n\`\`\``)
      continue
    }
    if (material.status === "skipped-duplicate") continue
    lines.push(referenceLine(material))
  }

  const sections = (["file", "skill", "todo"] as const).flatMap((kind) =>
    sectionsByKind[kind].length > 0 ? [kind === "file" ? "## Files" : kind === "skill" ? "## Skills" : "## Todos", ...sectionsByKind[kind]] : [],
  )
  if (sections.length === 0 && lines.length === 0) return undefined

  return [RESTORATION_SENTINEL, "Context restored from before the last compaction:", ...sections, ...(lines.length > 0 ? ["## Not restored", ...lines] : [])].join("\n")
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

  const messages = yield* sessions.messages({ sessionID })

  let compactionIdx = -1
  let tailStartID: string | undefined
  let restorationIdx = -1
  messages.forEach((msg, index) => {
    for (const part of msg.parts) {
      if (part.type === "compaction") {
        compactionIdx = index
        tailStartID = part.tail_start_id
      }
      if (part.type === "text" && part.text.startsWith(RESTORATION_SENTINEL)) restorationIdx = index
    }
  })
  if (compactionIdx === -1) return
  if (restorationIdx > compactionIdx) return

  const userMessage = messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return

  const todos = Option.isSome(todoOpt)
    ? yield* todoOpt.value.get(sessionID).pipe(Effect.orElseSucceed(() => []))
    : []

  const tailText = buildTailText(messages, tailStartID)
  const candidates = collectCandidates(messages, todos)
  const materials = yield* materializeCandidates(candidates, tailText, { fs, skill: skillOpt, todos, cfg })
  const text = renderMaterials(materials, cfg)
  if (!text) return

  const previous = userMessage.parts.findLast(
    (part): part is SessionV1.TextPart => part.type === "text" && part.text.startsWith(RESTORATION_SENTINEL),
  )
  if (previous?.text === text) return

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
