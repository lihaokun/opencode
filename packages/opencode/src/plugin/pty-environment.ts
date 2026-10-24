export * as PluginPtyEnvironment from "./pty-environment"

import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Context, Effect, Layer } from "effect"
import { InstanceStore } from "@/project/instance-store"
import { Plugin } from "."

export interface Interface {
  readonly get: (input: { directory: string; cwd: string }) => Effect.Effect<Record<string, string>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ServerPtyEnvironment") {}

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.succeed(Service, Service.of({ get: () => Effect.succeed({}) })),
  deps: [],
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const plugin = yield* Plugin.Service
    const instances = yield* InstanceStore.Service
    return Service.of({
      get: Effect.fn("PtyEnvironment.get")(function* (input) {
        return yield* instances.provide(
          { directory: input.directory },
          plugin
            .trigger("shell.env", { cwd: input.cwd }, { env: {} as Record<string, string> })
            .pipe(Effect.map((result) => result.env)),
        )
      }),
    })
  }),
)
