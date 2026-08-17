export * as ProjectDirectories from "./project-directories"

import { define, inventory } from "./event"
import { Project } from "./project"
import type { ContractResult, EventDefinitionError } from "./llm"

function initializeEventDefinition<A>(result: ContractResult<A, EventDefinitionError>): A {
  if (!result.ok) throw new globalThis.Error("Event definition initialization failed", { cause: result.error })
  return result.value
}

const Updated = initializeEventDefinition(define({
  type: "project.directories.updated",
  schema: { projectID: Project.ID },
}))
export const Event = { Updated, Definitions: inventory(Updated) }
