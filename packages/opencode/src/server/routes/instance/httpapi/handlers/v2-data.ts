// Handlers for the three /api read endpoints (see groups/v2-data.ts).
// Services resolve through LocationServiceMap using the routed instance's
// worktree — the query location and the routing key coincide for the TUI,
// which passes its current session directory in both places.
import * as InstanceState from "@/effect/instance-state"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { Reference } from "@opencode-ai/core/reference"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const v2DataHandlers = HttpApiBuilder.group(InstanceHttpApi, "v2Data", (handlers) =>
  Effect.gen(function* () {
    const located = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      const locations = yield* LocationServiceMap.Service
      const directory = AbsolutePath.make((yield* InstanceState.context).directory)
      return yield* effect.pipe(Effect.provide(locations.get(Location.Ref.make({ directory }))))
    })

    const envelope = Effect.fnUntraced(function* <A>(data: A) {
      const location = yield* Location.Service
      return {
        location: new Location.Info({
          directory: location.directory,
          workspaceID: location.workspaceID,
          project: location.project,
        }),
        data,
      }
    })

    return handlers
      .handle(
        "location.get",
        Effect.fn(function* () {
          return yield* located(
            Effect.gen(function* () {
              const location = yield* Location.Service
              return new Location.Info({
                directory: location.directory,
                workspaceID: location.workspaceID,
                project: location.project,
              })
            }),
          )
        }),
      )
      .handle(
        "reference.list",
        Effect.fn(function* () {
          return yield* located(Effect.gen(function* () { const data = yield* Reference.Service.use((reference) => reference.list()); return yield* envelope(data) }))
        }),
      )
      .handle(
        "fs.find",
        Effect.fn(function* (ctx) {
          return yield* located(Effect.gen(function* () { const data = yield* FileSystem.Service.use((fs) => fs.find(ctx.query)); return yield* envelope(data) }))
        }),
      )
  }),
)
