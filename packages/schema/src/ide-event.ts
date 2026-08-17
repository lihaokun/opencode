export * as IdeEvent from "./ide-event"

import { Schema } from "effect"
import { Event } from "./event"
import type { ContractResult, EventDefinitionError } from "./llm"

function initializeEventDefinition<A>(result: ContractResult<A, EventDefinitionError>): A {
  if (!result.ok) throw new globalThis.Error("Event definition initialization failed", { cause: result.error })
  return result.value
}

export const Installed = initializeEventDefinition(Event.define({
  type: "ide.installed",
  schema: {
    ide: Schema.String,
  },
}))

export const Definitions = Event.inventory(Installed)
