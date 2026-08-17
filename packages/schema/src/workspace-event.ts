export * as WorkspaceEvent from "./workspace-event"

import { Schema } from "effect"
import { Event } from "./event"
import { WorkspaceID } from "./workspace-id"
import type { ContractResult, EventDefinitionError } from "./llm"

function initializeEventDefinition<A>(result: ContractResult<A, EventDefinitionError>): A {
  if (!result.ok) throw new globalThis.Error("Event definition initialization failed", { cause: result.error })
  return result.value
}

export const ConnectionStatus = Schema.Struct({
  workspaceID: WorkspaceID,
  status: Schema.Literals(["connected", "connecting", "disconnected", "error"]),
}).annotate({ identifier: "WorkspaceEvent.ConnectionStatus" })
export interface ConnectionStatus extends Schema.Schema.Type<typeof ConnectionStatus> {}

export const Ready = initializeEventDefinition(Event.define({
  type: "workspace.ready",
  schema: {
    name: Schema.String,
  },
}))

export const Failed = initializeEventDefinition(Event.define({
  type: "workspace.failed",
  schema: {
    message: Schema.String,
  },
}))

export const Status = initializeEventDefinition(Event.define({
  type: "workspace.status",
  schema: ConnectionStatus.fields,
}))

export const Definitions = Event.inventory(Ready, Failed, Status)
