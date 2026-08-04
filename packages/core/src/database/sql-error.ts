export * as SqlErrorDiagnostic from "./sql-error"

import { Cause } from "effect"
import { isSqlError, isSqlErrorReason, type SqlErrorReason } from "effect/unstable/sql/SqlError"

export interface Info {
  readonly reason: string
  readonly operation?: string
  readonly retryable: boolean
  readonly code?: string | number
  readonly errno?: number
  readonly message?: string
}

export function extract(input: unknown): Info | undefined {
  const pending = [input]
  const visited = new Set<object>()

  while (pending.length > 0) {
    const value = pending.shift()
    if (!isObject(value) || visited.has(value)) continue
    visited.add(value)

    if (isSqlError(value)) return fromReason(value.reason)
    if (isSqlErrorReason(value)) return fromReason(value)

    if (Cause.isCause(value)) {
      for (const reason of value.reasons) {
        if (Cause.isFailReason(reason)) pending.push(reason.error)
        if (Cause.isDieReason(reason)) pending.push(reason.defect)
      }
      continue
    }

    if ("cause" in value) pending.push(value.cause)
    if ("reason" in value) pending.push(value.reason)
    if ("error" in value) pending.push(value.error)
    if ("defect" in value) pending.push(value.defect)
  }
  return undefined
}

function fromReason(reason: SqlErrorReason): Info {
  const cause = isObject(reason.cause) ? reason.cause : undefined
  return {
    reason: reason._tag as string,
    operation: typeof reason.operation === "string" ? reason.operation : undefined,
    retryable: reason.isRetryable,
    code: sqliteCode(cause),
    errno: typeof cause?.errno === "number" ? cause.errno : undefined,
    message: typeof cause?.message === "string" ? cause.message : undefined,
  }
}

function sqliteCode(value: Record<string, unknown> | undefined): string | number | undefined {
  if (typeof value?.code === "string" || typeof value?.code === "number") return value.code
  return undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
