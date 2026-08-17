export * as WorktreeEvent from "./worktree-event"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"
import type { ContractResult, EventDefinitionError } from "./llm"

function initializeEventDefinition<A>(result: ContractResult<A, EventDefinitionError>): A {
  if (!result.ok) throw new globalThis.Error("Event definition initialization failed", { cause: result.error })
  return result.value
}

export const Ready = initializeEventDefinition(Event.define({
  type: "worktree.ready",
  schema: {
    name: Schema.String,
    branch: optional(Schema.String),
  },
}))

export const Failed = initializeEventDefinition(Event.define({
  type: "worktree.failed",
  schema: {
    message: Schema.String,
  },
}))

export const Definitions = Event.inventory(Ready, Failed)
