export * as InstallationEvent from "./installation-event"

import { Schema } from "effect"
import { Event } from "./event"
import type { ContractResult, EventDefinitionError } from "./llm"

function initializeEventDefinition<A>(result: ContractResult<A, EventDefinitionError>): A {
  if (!result.ok) throw new globalThis.Error("Event definition initialization failed", { cause: result.error })
  return result.value
}

export const Updated = initializeEventDefinition(Event.define({
  type: "installation.updated",
  schema: {
    version: Schema.String,
  },
}))

export const UpdateAvailable = initializeEventDefinition(Event.define({
  type: "installation.update-available",
  schema: {
    version: Schema.String,
  },
}))

export const Definitions = Event.inventory(Updated, UpdateAvailable)
