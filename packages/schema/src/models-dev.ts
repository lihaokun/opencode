export * as ModelsDev from "./models-dev"

import { define, inventory } from "./event"
import type { ContractResult, EventDefinitionError } from "./llm"

function initializeEventDefinition<A>(result: ContractResult<A, EventDefinitionError>): A {
  if (!result.ok) throw new globalThis.Error("Event definition initialization failed", { cause: result.error })
  return result.value
}

const Refreshed = initializeEventDefinition(define({
  type: "models-dev.refreshed",
  schema: {},
}))
export const Event = { Refreshed, Definitions: inventory(Refreshed) }
