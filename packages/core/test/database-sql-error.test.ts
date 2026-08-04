import { expect, test } from "bun:test"
import path from "path"
import { Cause, Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SqlErrorDiagnostic } from "@opencode-ai/core/database/sql-error"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { PartTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { tmpdir } from "./fixture/tmpdir"

const run = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped))

test("extracts a foreign-key constraint through Drizzle and Effect causes without exposing params", async () => {
  const marker = "sensitive-prompt-marker"
  const diagnostic = await run(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const data = { type: "text", text: marker } as typeof PartTable.$inferInsert.data
      const part: typeof PartTable.$inferInsert = {
        id: SessionV1.PartID.ascending(),
        message_id: SessionV1.MessageID.ascending(),
        session_id: SessionSchema.ID.make("ses_missing_parent"),
        data,
      }
      const error = yield* db.insert(PartTable).values(part).run().pipe(Effect.flip)

      return SqlErrorDiagnostic.extract(Cause.die(error))
    }),
  )

  expect(diagnostic).toMatchObject({
    reason: "ConstraintError",
    operation: "execute",
    retryable: false,
    code: "SQLITE_CONSTRAINT_FOREIGNKEY",
    errno: 787,
    message: "FOREIGN KEY constraint failed",
  })
  expect(JSON.stringify(diagnostic)).not.toContain(marker)
})

test("extracts a lock timeout from a failed BEGIN IMMEDIATE", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "locked.sqlite")
  const diagnostic = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run("PRAGMA busy_timeout = 0")

      const sqlite = yield* Effect.promise(() => import("bun:sqlite"))
      const holder = new sqlite.Database(filename)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (holder.inTransaction) holder.run("ROLLBACK")
          holder.close()
        }),
      )
      holder.run("PRAGMA busy_timeout = 0")
      holder.run("BEGIN IMMEDIATE")

      const error = yield* db.transaction(() => Effect.void, { behavior: "immediate" }).pipe(Effect.flip)
      return SqlErrorDiagnostic.extract(error)
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )

  expect(diagnostic).toMatchObject({
    reason: "LockTimeoutError",
    operation: "execute",
    retryable: true,
    code: "SQLITE_BUSY",
    errno: 5,
    message: "database is locked",
  })
})
