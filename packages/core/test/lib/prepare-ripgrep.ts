import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { RipgrepBinary } from "@opencode-ai/core/ripgrep/binary"

await Effect.gen(function* () {
  const binary = yield* RipgrepBinary.Service
  yield* binary.filepath
}).pipe(Effect.scoped, Effect.provide(AppNodeBuilder.build(RipgrepBinary.node)), Effect.runPromise)
