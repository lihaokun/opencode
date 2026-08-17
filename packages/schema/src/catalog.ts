export * as Catalog from "./catalog"

import { define, inventory } from "./event"
import type { ContractResult, EventDefinitionError } from "./llm"

function initializeEventDefinition<A>(result: ContractResult<A, EventDefinitionError>): A {
  if (!result.ok) throw new globalThis.Error("Event definition initialization failed", { cause: result.error })
  return result.value
}

const Updated = initializeEventDefinition(define({ type: "catalog.updated", schema: {} }))
export const Event = { Updated, Definitions: inventory(Updated) }
