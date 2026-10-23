import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectCopy } from "@opencode-ai/schema/project-copy"
import { Project } from "@opencode-ai/schema/project"
import { Schema, Struct } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"

export const GenerateNamePayload = Schema.Struct({
  context: Schema.optional(Schema.String),
})

export class ProjectCopyError extends Schema.ErrorClass<ProjectCopyError>("ProjectCopyError")(
  {
    name: Schema.Literal("ProjectCopyError"),
    data: Schema.Struct({
      message: Schema.String,
      forceRequired: Schema.optional(Schema.Boolean),
    }),
  },
  { httpApiStatus: 400 },
) {}

const CreatePayload = Schema.Struct(Struct.omit(ProjectCopy.CreateInput.fields, ["projectID", "sourceDirectory"]))
const RemovePayload = Schema.Struct(Struct.omit(ProjectCopy.RemoveInput.fields, ["projectID"]))

export const ProjectCopyApi = HttpApi.make("projectCopyName").add(
  HttpApiGroup.make("projectCopyName")
    .add(
      HttpApiEndpoint.post("generateName", "/experimental/project/:projectID/copy/generate-name", {
        params: { projectID: ProjectV2.ID },
        query: WorkspaceRoutingQuery,
        payload: GenerateNamePayload,
        success: Schema.Struct({ name: Schema.String }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.projectCopy.generateName",
          summary: "Generate project copy name",
          description: "Generate a short name for a project copy from task context.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("projectCopy.create", "/experimental/project/:projectID/copy", {
        params: { projectID: Project.ID },
        query: WorkspaceRoutingQuery,
        payload: CreatePayload,
        success: ProjectCopy.Copy,
        error: ProjectCopyError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.projectCopy.create",
          summary: "Create project copy",
          description: "Create a project copy with the configured strategy.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.delete("projectCopy.remove", "/experimental/project/:projectID/copy", {
        params: { projectID: Project.ID },
        query: WorkspaceRoutingQuery,
        payload: RemovePayload,
        success: HttpApiSchema.NoContent,
        error: ProjectCopyError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.projectCopy.remove",
          summary: "Remove project copy",
          description: "Remove a project copy directory.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("projectCopy.refresh", "/experimental/project/:projectID/copy/refresh", {
        params: { projectID: Project.ID },
        query: WorkspaceRoutingQuery,
        success: HttpApiSchema.NoContent,
        error: ProjectCopyError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.projectCopy.refresh",
          summary: "Refresh project copy",
          description: "Refresh project copy directory state.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "projectCopy", description: "Project copy routes." }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
