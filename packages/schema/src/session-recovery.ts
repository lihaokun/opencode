export * as IncompleteStreamRecovery from "./session-recovery"

import { Schema } from "effect"
import { NonNegativeInt } from "./schema"

export const Classification = Schema.Literal("incomplete-stream").annotate({
  identifier: "Session.IncompleteStreamRecovery.Classification",
})
export type Classification = typeof Classification.Type

export const Action = Schema.Literals(["safe-retry", "continue-after-settled-tools", "manual-stop"]).annotate({
  identifier: "Session.IncompleteStreamRecovery.Action",
})
export type Action = typeof Action.Type

export const Reason = Schema.Literals([
  "no-tool-evidence",
  "settled-tools",
  "uncertain-side-effect",
  "retry-exhausted",
  "blocked",
  "persistence-failure",
]).annotate({ identifier: "Session.IncompleteStreamRecovery.Reason" })
export type Reason = typeof Reason.Type

export const ToolState = Schema.Literals(["pending", "running", "completed", "error"]).annotate({
  identifier: "Session.IncompleteStreamRecovery.ToolState",
})
export type ToolState = typeof ToolState.Type

export interface ToolEvidence extends Schema.Schema.Type<typeof ToolEvidence> {}
export const ToolEvidence = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  state: ToolState,
  completeCall: Schema.Boolean,
  inputPersisted: Schema.Boolean,
  providerExecuted: Schema.Boolean,
  terminalResultPersisted: Schema.Boolean,
  interrupted: Schema.Boolean,
}).annotate({ identifier: "Session.IncompleteStreamRecovery.ToolEvidence" })

export interface Retry extends Schema.Schema.Type<typeof Retry> {}
export const Retry = Schema.Struct({
  attempt: NonNegativeInt,
  limit: NonNegativeInt,
}).annotate({ identifier: "Session.IncompleteStreamRecovery.Retry" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  classification: Classification,
  action: Action,
  reason: Reason,
  tools: Schema.Array(ToolEvidence),
  retry: Retry,
}).annotate({ identifier: "Session.IncompleteStreamRecovery" })
