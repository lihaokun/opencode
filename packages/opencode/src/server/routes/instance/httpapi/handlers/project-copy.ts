import * as InstanceState from "@/effect/instance-state"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { MessageID, SessionID } from "@/session/schema"
import { Slug } from "@opencode-ai/core/util/slug"
import { LLMEvent } from "@opencode-ai/llm"
import { ProjectCopy } from "@opencode-ai/core/project/copy"
import { Git } from "@opencode-ai/core/git"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Effect, Stream } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { ProjectCopyError } from "../groups/project-copy"
import { InstanceHttpApi } from "../api"

const COPY_NAME_AGENT: Agent.Info = {
  name: "project-copy-name",
  mode: "primary",
  permission: [],
  options: {},
  native: true,
  prompt: "",
}

export const projectCopyHandlers = HttpApiBuilder.group(InstanceHttpApi, "projectCopyName", (handlers) =>
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    const provider = yield* Provider.Service

    const generateName = Effect.fn("ProjectCopyHttpApi.generateName")(function* (context: string | undefined) {
      const text = context?.trim()
      if (!text) return Slug.create()
      const fallback = yield* provider.defaultModel().pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!fallback) return Slug.create()
      const model =
        (yield* provider.getSmallModel(fallback.providerID)) ??
        (yield* provider.getModel(fallback.providerID, fallback.modelID))
      const sessionID = SessionID.descending()
      const result = yield* llm
        .stream({
          agent: COPY_NAME_AGENT,
          user: {
            id: MessageID.ascending(),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: COPY_NAME_AGENT.name,
            model: { providerID: model.providerID, modelID: model.id },
          },
          system: [],
          small: true,
          tools: {},
          model,
          sessionID,
          retries: 2,
          messages: [{ role: "user", content: `Generate a short 2-3 word name that describes this task:\n${text}` }],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((event) => event.text),
          Stream.mkString,
        )
      const output = result.trim()
      return output ? slugify(output.split(/\s+/).slice(0, 3).join(" ")) : Slug.create()
    })

    const badRequest = <A>(effect: Effect.Effect<A, ProjectCopy.Error>) =>
      effect.pipe(
        Effect.mapError(
          (error) =>
            new ProjectCopyError({
              name: "ProjectCopyError",
              data: {
                message: message(error),
                forceRequired: error instanceof Git.WorktreeError ? error.forceRequired : undefined,
              },
            }),
        ),
      )

    const located = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      const locations = yield* LocationServiceMap.Service
      return yield* effect.pipe(
        Effect.provide(
          locations.get(Location.Ref.make({ directory: AbsolutePath.make((yield* InstanceState.context).worktree) })),
        ),
      )
    })

    return handlers
      .handle("generateName", (ctx) =>
        generateName(ctx.payload.context).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("project copy name generation failed", {
              projectID: ctx.params.projectID,
              cause,
            }).pipe(Effect.as(Slug.create())),
          ),
          Effect.map((name) => ({ name })),
        ),
      )
      .handle("projectCopy.create", (ctx) =>
        Effect.gen(function* () {
          const worktree = AbsolutePath.make((yield* InstanceState.context).worktree)
          return yield* located(
            Effect.gen(function* () {
              const copies = yield* ProjectCopy.Service
              return yield* badRequest(
                copies.create({
                  ...ctx.payload,
                  projectID: ctx.params.projectID,
                  sourceDirectory: worktree,
                }),
              )
            }),
          )
        }),
      )
      .handle("projectCopy.remove", (ctx) =>
        located(
          Effect.gen(function* () {
            const copies = yield* ProjectCopy.Service
            return yield* badRequest(copies.remove({ ...ctx.payload, projectID: ctx.params.projectID })).pipe(
              Effect.as(HttpApiSchema.NoContent.make()),
            )
          }),
        ),
      )
      .handle("projectCopy.refresh", (ctx) =>
        located(
          Effect.gen(function* () {
            const copies = yield* ProjectCopy.Service
            return yield* badRequest(copies.refresh({ projectID: ctx.params.projectID })).pipe(
              Effect.as(HttpApiSchema.NoContent.make()),
            )
          }),
        ),
      )
  }),
)

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function message(error: ProjectCopy.Error) {
  if (error instanceof ProjectCopy.SourceDirectoryNotFoundError)
    return `Project copy source not found: ${error.directory}`
  if (error instanceof ProjectCopy.DestinationExistsError)
    return `Project copy destination already exists: ${error.directory}`
  if (error instanceof ProjectCopy.DirectoryUnavailableError)
    return `Project copy directory unavailable: ${error.directory}`
  if (error instanceof ProjectCopy.InvalidDirectoryError) return `Invalid project copy directory: ${error.directory}`
  if (error instanceof ProjectCopy.StrategyUnavailableError)
    return `Project copy strategy unavailable: ${error.strategy}`
  return error.message
}
