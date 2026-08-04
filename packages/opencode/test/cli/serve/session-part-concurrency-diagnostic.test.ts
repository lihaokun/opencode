import { describe, expect } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Effect, Fiber } from "effect"
import { cliIt } from "../../lib/cli-process"
import { pollWithTimeout } from "../../lib/effect"
import { raw, reply, type TestLLMServer } from "../../lib/llm-server"

type Sdk = ReturnType<typeof createOpencodeClient>

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function heldStructuredReply(wait: PromiseLike<unknown>) {
  const item = reply().tool("StructuredOutput", { answer: 4 }).item()
  if (item.type !== "sse") throw new Error("structured reply must produce an SSE item")
  return raw({ head: [], tail: [...item.head, ...item.tail], wait })
}

function structuredRequestCount(inputs: Record<string, unknown>[]) {
  return inputs.filter((input) => JSON.stringify(input.tools ?? []).includes("StructuredOutput")).length
}

function isStructuredRequest(input: { body: Record<string, unknown> }) {
  return JSON.stringify(input.body.tools ?? []).includes("StructuredOutput")
}

function waitForStructuredRequests(llm: TestLLMServer["Service"], count: number) {
  return pollWithTimeout(
    llm.inputs.pipe(Effect.map((inputs) => (structuredRequestCount(inputs) >= count ? inputs : undefined))),
    `timed out waiting for ${count} structured-output provider requests`,
    "15 seconds",
  )
}

async function initializeGitProject(home: string) {
  const directory = path.join(home, "project")
  await mkdir(directory, { recursive: true })
  await Bun.write(path.join(directory, "README.md"), "diagnostic fixture\n")
  for (const args of [
    ["init", "--quiet"],
    ["config", "user.name", "OpenCode Test"],
    ["config", "user.email", "test@opencode.ai"],
    ["add", "README.md"],
    ["commit", "--quiet", "-m", "fixture"],
  ]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode === 0) continue
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
  }
  return directory
}

async function createSession(sdk: Sdk, title: string) {
  const result = await sdk.session.create({
    title,
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  })
  if (!result.data) throw new Error(`session create failed: ${JSON.stringify(result.error)}`)
  return result.data.id
}

function prompt(sdk: Sdk, sessionID: string, marker: string) {
  return sdk.session.prompt({
    sessionID,
    agent: "build",
    model: { providerID: "test", modelID: "test-model" },
    tools: {},
    parts: [{ type: "text", text: marker }],
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: { answer: { type: "number" } },
        required: ["answer"],
      },
      retryCount: 0,
    },
  })
}

function answer(result: Awaited<ReturnType<typeof prompt>>) {
  return result.data?.info.role === "assistant" ? result.data.info.structured : undefined
}

describe("session Part concurrency diagnostics", () => {
  cliIt.live(
    "allows three concurrent prompts with no cleanup or post-resolution cleanup",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() => initializeGitProject(home))
        const server = yield* opencode.serve({
          extraArgs: ["--print-logs"],
          env: { OPENCODE_LOG_LEVEL: "DEBUG" },
        })
        const sdk = createOpencodeClient({ baseUrl: server.url, directory })
        let expectedStructuredRequests = 0

        // A: three concurrent prompts, no cleanup. This exercises the real
        // listener, file-backed WAL database, Git snapshot child processes,
        // and one shared provider release gate.
        const baselineGate = deferred()
        yield* llm.pushMatch(
          isStructuredRequest,
          ...Array.from({ length: 3 }, () => heldStructuredReply(baselineGate.promise)),
        )
        const baselineSessions = yield* Effect.promise(() =>
          Promise.all(Array.from({ length: 3 }, (_, index) => createSession(sdk, `baseline-${index}`))),
        )
        const baselineFiber = yield* Effect.forkScoped(
          Effect.promise(() => Promise.all(baselineSessions.map((sessionID) => prompt(sdk, sessionID, "baseline")))),
        )
        expectedStructuredRequests += 3
        yield* waitForStructuredRequests(llm, expectedStructuredRequests)
        baselineGate.resolve()
        const baseline = yield* Fiber.join(baselineFiber)
        expect(baseline.map((result) => result.response.status)).toEqual([200, 200, 200])
        expect(baseline.map(answer)).toEqual([{ answer: 4 }, { answer: 4 }, { answer: 4 }])

        // B: each caller deletes only after its own synchronous prompt promise
        // resolves. This is the cleanup ordering reported by Issue #6.
        const resolvedCleanupGate = deferred()
        yield* llm.pushMatch(
          isStructuredRequest,
          ...Array.from({ length: 3 }, () => heldStructuredReply(resolvedCleanupGate.promise)),
        )
        const resolvedCleanupSessions = yield* Effect.promise(() =>
          Promise.all(Array.from({ length: 3 }, (_, index) => createSession(sdk, `resolved-cleanup-${index}`))),
        )
        const resolvedCleanupFiber = yield* Effect.forkScoped(
          Effect.promise(() =>
            Promise.all(
              resolvedCleanupSessions.map(async (sessionID) => {
                const result = await prompt(sdk, sessionID, "resolved-cleanup")
                const deleted = await sdk.session.delete({ sessionID })
                return { result, deleted }
              }),
            ),
          ),
        )
        expectedStructuredRequests += 3
        yield* waitForStructuredRequests(llm, expectedStructuredRequests)
        resolvedCleanupGate.resolve()
        const resolvedCleanup = yield* Fiber.join(resolvedCleanupFiber)
        expect(resolvedCleanup.map((item) => item.result.response.status)).toEqual([200, 200, 200])
        expect(resolvedCleanup.map((item) => answer(item.result))).toEqual([
          { answer: 4 },
          { answer: 4 },
          { answer: 4 },
        ])
        expect(resolvedCleanup.map((item) => item.deleted.response.status)).toEqual([200, 200, 200])
      }),
    90_000,
  )

  cliIt.live(
    "captures the foreign-key failure when deletion overlaps a live prompt",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() => initializeGitProject(home))
        const server = yield* opencode.serve({
          extraArgs: ["--print-logs"],
          env: { OPENCODE_LOG_LEVEL: "DEBUG" },
        })
        const sdk = createOpencodeClient({ baseUrl: server.url, directory })

        // C: hold the provider before its first stream chunk, observe the
        // committed assistant Message through a read-only WAL connection,
        // then delete the Session over HTTP.
        // Releasing the provider makes the first step-start Part arrive late.
        const overlapGate = deferred()
        yield* llm.pushMatch(isStructuredRequest, heldStructuredReply(overlapGate.promise))
        const overlapSession = yield* Effect.promise(() => createSession(sdk, "overlap"))
        const sqlite = yield* Effect.promise(() => import("bun:sqlite"))
        const observer = new sqlite.Database(path.join(home, "opencode.db"), { readonly: true })
        yield* Effect.addFinalizer(() => Effect.sync(() => observer.close()))
        const overlapFiber = yield* Effect.forkScoped(
          Effect.promise(() => prompt(sdk, overlapSession, "sensitive-overlap-marker")),
        )
        const beforeDelete = yield* pollWithTimeout(
          Effect.sync(
            () =>
              observer
                .query<{ id: string; parts: number }, [string]>(
                  `SELECT message.id, COUNT(part.id) AS parts
                 FROM message
                 LEFT JOIN part ON part.message_id = message.id
                 WHERE message.session_id = ? AND json_extract(message.data, '$.role') = 'assistant'
                 GROUP BY message.id`,
                )
                .get(overlapSession) ?? undefined,
          ),
          "assistant Message was not observable before deletion",
          "10 seconds",
        )
        expect(beforeDelete.parts).toBe(0)
        const deleted = yield* Effect.promise(() => sdk.session.delete({ sessionID: overlapSession }))
        expect(deleted.response.status).toBe(200)
        overlapGate.resolve()
        const logs = yield* pollWithTimeout(
          Effect.sync(() => {
            const value = server.stderr()
            return value.includes("ConstraintError") && value.includes("SQLITE_CONSTRAINT_FOREIGNKEY")
              ? value
              : undefined
          }),
          "server logs did not preserve the SQLite foreign-key diagnostic",
          "10 seconds",
        )
        expect(logs).toContain("database.reason=ConstraintError")
        expect(logs).toContain("database.code=SQLITE_CONSTRAINT_FOREIGNKEY")
        expect(logs).not.toContain("sensitive-overlap-marker")

        const overlap = yield* Fiber.join(overlapFiber).pipe(
          Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.succeed(undefined) }),
        )
        if (overlap) {
          expect(overlap.response.status).not.toBe(200)
          expect(JSON.stringify(overlap)).not.toContain("sensitive-overlap-marker")
        }
      }),
    90_000,
  )
})
