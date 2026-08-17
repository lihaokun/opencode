export * as SessionStatusEvent from "./session-status-event"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"
import { NonNegativeInt } from "./schema"
import { SessionID } from "./session-id"
import type { ContractResult, EventDefinitionError } from "./llm"

function initializeEventDefinition<A>(result: ContractResult<A, EventDefinitionError>): A {
  if (!result.ok) throw new globalThis.Error("Event definition initialization failed", { cause: result.error })
  return result.value
}

export const Info = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("idle"),
  }),
  Schema.Struct({
    type: Schema.Literal("retry"),
    attempt: NonNegativeInt,
    message: Schema.String,
    action: optional(
      Schema.Struct({
        reason: Schema.String,
        provider: Schema.String,
        title: Schema.String,
        message: Schema.String,
        label: Schema.String,
        link: optional(Schema.String),
      }),
    ),
    next: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("busy"),
  }),
]).annotate({ identifier: "SessionStatus" })
export type Info = Schema.Schema.Type<typeof Info>

export const Status = initializeEventDefinition(Event.define({
  type: "session.status",
  schema: {
    sessionID: SessionID,
    status: Info,
  },
}))

// deprecated
export const Idle = initializeEventDefinition(Event.define({
  type: "session.idle",
  schema: {
    sessionID: SessionID,
  },
}))

export const Definitions = Event.inventory(Status, Idle)
