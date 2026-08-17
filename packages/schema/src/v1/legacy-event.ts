export * as LegacyEvent from "./legacy-event"

import { Schema } from "effect"
import { define, inventory } from "../event"
import { SessionID } from "../session-id"
import { SessionV1 } from "./session"
import type { ContractResult, EventDefinitionError } from "../llm"

function initializeEventDefinition<A>(result: ContractResult<A, EventDefinitionError>): A {
  if (!result.ok) throw new globalThis.Error("Event definition initialization failed", { cause: result.error })
  return result.value
}

export const CommandExecuted = initializeEventDefinition(define({
  type: "command.executed",
  schema: {
    name: Schema.String,
    sessionID: SessionID,
    arguments: Schema.String,
    messageID: SessionV1.MessageID,
  },
}))

export const Definitions = inventory(CommandExecuted)
