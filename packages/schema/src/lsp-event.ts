export * as LspEvent from "./lsp-event"

import { Event } from "./event"
import type { ContractResult, EventDefinitionError } from "./llm"

function initializeEventDefinition<A>(result: ContractResult<A, EventDefinitionError>): A {
  if (!result.ok) throw new globalThis.Error("Event definition initialization failed", { cause: result.error })
  return result.value
}

export const Updated = initializeEventDefinition(Event.define({ type: "lsp.updated", schema: {} }))

export const Definitions = Event.inventory(Updated)
