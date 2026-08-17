export * as VcsEvent from "./vcs-event"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"
import type { ContractResult, EventDefinitionError } from "./llm"

function initializeEventDefinition<A>(result: ContractResult<A, EventDefinitionError>): A {
  if (!result.ok) throw new globalThis.Error("Event definition initialization failed", { cause: result.error })
  return result.value
}

export const BranchUpdated = initializeEventDefinition(Event.define({
  type: "vcs.branch.updated",
  schema: {
    branch: optional(Schema.String),
  },
}))

export const Definitions = Event.inventory(BranchUpdated)
