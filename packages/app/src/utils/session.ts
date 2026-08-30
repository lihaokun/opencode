import type { SessionApi, SessionInfo, SessionListInput } from "@opencode-ai/client/promise"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { withTimestampedFallback } from "./session-title"

export function normalizeSessionInfo(input: SessionInfo | Session): Session {
  if (!("location" in input)) return input
  const revert = input.revert as
    | (NonNullable<typeof input.revert> & {
        messageTimeCreated?: number
        partTimeCreated?: number
        diff?: string
      })
    | undefined
  return {
    id: input.id,
    slug: input.id,
    projectID: input.projectID,
    workspaceID: input.location.workspaceID,
    directory: input.location.directory,
    path: input.subpath,
    parentID: input.parentID,
    cost: input.cost,
    tokens: input.tokens,
    title: withTimestampedFallback(input),
    agent: input.agent,
    model: input.model,
    version: "",
    time: input.time,
    revert: revert && {
      messageID: revert.messageID,
      messageTimeCreated: revert.messageTimeCreated,
      partID: revert.partID,
      partTimeCreated: revert.partTimeCreated,
      snapshot: revert.snapshot,
      diff: revert.diff,
    },
  }
}

export async function listAllSessions(api: Pick<SessionApi, "list">, input: Omit<SessionListInput, "cursor">) {
  const load = async (cursor?: string): Promise<Session[]> => {
    const result = await api.list({ ...input, limit: input.limit ?? 100, cursor })
    const sessions = result.data.map(normalizeSessionInfo)
    if (result.data.length === 0 || !result.cursor.next) return sessions
    return [...sessions, ...(await load(result.cursor.next))]
  }
  return load()
}
