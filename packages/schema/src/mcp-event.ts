export * as McpEvent from "./mcp-event"

import { Schema } from "effect"
import { Event } from "./event"
import type { ContractResult, EventDefinitionError } from "./llm"

function initializeEventDefinition<A>(result: ContractResult<A, EventDefinitionError>): A {
  if (!result.ok) throw new globalThis.Error("Event definition initialization failed", { cause: result.error })
  return result.value
}

export const ToolsChanged = initializeEventDefinition(Event.define({
  type: "mcp.tools.changed",
  schema: {
    server: Schema.String,
  },
}))

export const BrowserOpenFailed = initializeEventDefinition(Event.define({
  type: "mcp.browser.open.failed",
  schema: {
    mcpName: Schema.String,
    url: Schema.String,
  },
}))

export const Definitions = Event.inventory(ToolsChanged, BrowserOpenFailed)
