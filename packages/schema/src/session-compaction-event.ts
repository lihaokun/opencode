export * as SessionCompactionEvent from "./session-compaction-event"

import { Event } from "./event"
import { SessionID } from "./session-id"
import type { ContractResult, EventDefinitionError } from "./llm"

function initializeEventDefinition<A>(result: ContractResult<A, EventDefinitionError>): A {
  if (!result.ok) throw new globalThis.Error("Event definition initialization failed", { cause: result.error })
  return result.value
}

export const Compacted = initializeEventDefinition(Event.define({
  type: "session.compacted",
  schema: {
    sessionID: SessionID,
  },
}))

export const Definitions = Event.inventory(Compacted)
