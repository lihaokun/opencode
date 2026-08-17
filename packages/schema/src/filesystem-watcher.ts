export * as FileSystemWatcher from "./filesystem-watcher"

import { Schema } from "effect"
import { define, inventory } from "./event"
import type { ContractResult, EventDefinitionError } from "./llm"

function initializeEventDefinition<A>(result: ContractResult<A, EventDefinitionError>): A {
  if (!result.ok) throw new globalThis.Error("Event definition initialization failed", { cause: result.error })
  return result.value
}

const Updated = initializeEventDefinition(define({
  type: "file.watcher.updated",
  schema: {
    file: Schema.String,
    event: Schema.Literals(["add", "change", "unlink"]),
  },
}))
export const Event = { Updated, Definitions: inventory(Updated) }
