// The three /api read endpoints TUI still consumes after the rail removal:
// autocomplete's reference list and file search, plus the location resolve
// that keys the reference snapshot. Wire shapes match the SDK contracts the
// TUI was generated against (deepObject location query, {location, data}
// envelope, v2.* identifiers) so no client regeneration is needed.
import { FileSystem } from "@opencode-ai/schema/filesystem"
import { Location as LocationSchema } from "@opencode-ai/schema/location"
import { Reference } from "@opencode-ai/schema/reference"
import { PositiveInt } from "@opencode-ai/schema/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"

const LocationQuery = Schema.Struct({
  location: Schema.optional(
    Schema.Struct({
      directory: Schema.optional(Schema.String),
      workspace: Schema.optional(Schema.String),
    }),
  ),
}).annotate({ identifier: "LocationQuery" })

const locationQueryOpenApi = OpenApi.annotations({
  transform: (operation) => {
    const parameters = operation.parameters
    if (!Array.isArray(parameters)) return operation
    return {
      ...operation,
      parameters: parameters.map((parameter) =>
        parameter?.name === "location" && parameter?.in === "query"
          ? { ...parameter, style: "deepObject", explode: true }
          : parameter,
      ),
    }
  },
})

export const V2DataApi = HttpApi.make("v2-data").add(
  HttpApiGroup.make("v2Data")
    .add(
      HttpApiEndpoint.get("location.get", "/api/location", {
        query: LocationQuery,
        success: LocationSchema.Info,
      })
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.location.get",
            summary: "Get location",
            description: "Resolve the requested location or the server default location.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("reference.list", "/api/reference", {
        query: LocationQuery,
        success: LocationSchema.response(Schema.Array(Reference.Info)),
      })
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.reference.list",
            summary: "List references",
            description: "List references available in the requested location.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("fs.find", "/api/fs/find", {
        query: Schema.Struct({
          ...LocationQuery.fields,
          query: FileSystem.FindInput.fields.query,
          type: FileSystem.FindInput.fields.type,
          limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional),
        }),
        success: LocationSchema.response(Schema.Array(FileSystem.Entry)),
      })
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.fs.find",
            summary: "Find files",
            description: "Fuzzy-find files and directories relative to the requested location.",
          }),
        ),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
