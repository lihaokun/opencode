export * as Plugin from "./plugin"

import { Schema } from "effect"
import { define, inventory } from "./event"
import type { ContractResult, EventDefinitionError } from "./llm"

function initializeEventDefinition<A>(result: ContractResult<A, EventDefinitionError>): A {
  if (!result.ok) throw new globalThis.Error("Event definition initialization failed", { cause: result.error })
  return result.value
}

export const ID = Schema.String.pipe(Schema.brand("Plugin.ID"))
export type ID = typeof ID.Type

const Added = initializeEventDefinition(define({
  type: "plugin.added",
  schema: { id: ID },
}))
export const Event = { Added, Definitions: inventory(Added) }
