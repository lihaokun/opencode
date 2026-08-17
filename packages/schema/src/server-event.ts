export * as ServerEvent from "./server-event"

import { Event } from "./event"
import type { ContractResult, EventDefinitionError } from "./llm"

function initializeEventDefinition<A>(result: ContractResult<A, EventDefinitionError>): A {
  if (!result.ok) throw new globalThis.Error("Event definition initialization failed", { cause: result.error })
  return result.value
}

export const Connected = initializeEventDefinition(Event.define({ type: "server.connected", schema: {} }))
export const Disposed = initializeEventDefinition(Event.define({ type: "global.disposed", schema: {} }))

export const Definitions = Event.inventory(Connected, Disposed)
