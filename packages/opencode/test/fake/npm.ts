import { Npm } from "@opencode-ai/core/npm"
import { Effect, Layer, Ref } from "effect"

export const noop = Layer.mock(Npm.Service)({
  install: () => Effect.void,
})

export interface InstallCall {
  dir: string
  version: string | undefined
}

const log = Ref.makeUnsafe<InstallCall[]>([])

export const reset = Effect.gen(function* () {
  yield* Ref.set(log, [])
})

export const calls = Effect.map(Ref.get(log), (list) => [...list])

// Records install() calls so tests can assert whether (and with which version)
// the plugin SDK install was attempted. State is process-wide: call
// `NpmTest.reset` at test start when isolation matters.
export const recording = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: (pkg) => Effect.die(`NpmTest.recording.add unexpected: ${pkg}`),
    install: (dir, input) =>
      Effect.gen(function* () {
        yield* Ref.update(log, (list) => [
          ...list,
          { dir, version: input?.add.find((p) => p.name === "@opencode-ai/plugin")?.version },
        ])
      }),
    which: () => Effect.succeed(undefined),
  }),
)

export * as NpmTest from "./npm"