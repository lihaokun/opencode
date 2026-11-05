// Tier-A smoke tests for read-only commands. Each test asserts only that the
// command exits 0 and produces *some* output in the isolated harness env.
//
// These are not behavioral tests — they're the cheapest possible signal that
// the dependency-layer wiring (config load, DB init, server boot, provider
// resolution) doesn't crash for the broad class of "no inputs, no side
// effects" commands. A regression in any shared layer (an Effect.fail that
// propagates out of a service constructor, a renamed env var, a broken DB
// migration) will fail one or more of these tests.
//
// If a future change should make one of these commands intentionally fail in
// an empty env, update the assertion + add a note explaining the new contract.
//
// Speed: each test pays ~1.5s for bun startup. 7 tests serialize within this
// file. See script/prebuild-test-cli.ts for an opt-in pre-built binary that
// cuts per-spawn cost when this suite gets bigger.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { CLI_PROCESS_TIMEOUT_MS, cliIt } from "../../lib/cli-process"

// Windows CI needs more room for real CLI startup. Keep the outer deadline
// above the child deadline so fixture setup and timeout cleanup can finish.
const timeoutMs = process.platform === "win32" ? 120_000 : CLI_PROCESS_TIMEOUT_MS
const testTimeoutMs = timeoutMs + 60_000

describe("opencode read-only commands (smoke)", () => {
  // `mcp list` reads MCP server config and pings each one. With the empty
  // OPENCODE_CONFIG_CONTENT={} we provide, no servers should be configured
  // and the command should report that cleanly.
  cliIt.live(
    "mcp list: exits 0",
    ({ opencode }) =>
      Effect.gen(function* () {
        const r = yield* opencode.spawn(["mcp", "list"], { timeoutMs })
        opencode.expectExit(r, 0, "mcp list")
      }),
    testTimeoutMs,
  )

  // `providers list` enumerates credentials + env-resolved providers.
  // (Not config-injected ones — those don't appear here by design.) The
  // Credentials header always renders; the Environment header only renders
  // when at least one provider env var is set, which the isolation harness
  // deliberately doesn't guarantee. Assert the always-present marker so the
  // test passes on a clean CI runner without env-var leakage.
  cliIt.live(
    "providers list: exits 0 and prints the credentials section",
    ({ opencode }) =>
      Effect.gen(function* () {
        const r = yield* opencode.spawn(["providers", "list"], { timeoutMs })
        opencode.expectExit(r, 0, "providers list")
        expect(r.stdout).toContain("Credentials")
      }),
    testTimeoutMs,
  )

  // `models` lists models from configured providers. Our test/test-model
  // should appear because it's wired into the test provider config.
  cliIt.live(
    "models: exits 0 and lists the test model",
    ({ opencode }) =>
      Effect.gen(function* () {
        const r = yield* opencode.spawn(["models"], { timeoutMs })
        opencode.expectExit(r, 0, "models")
        expect(r.stdout).toContain("test/test-model")
      }),
    testTimeoutMs,
  )

  // `agent list` walks the agent config. Empty config means no agents
  // configured; the command should still exit 0 with a "no agents" line or
  // similar. We don't pin the message — just exit cleanly.
  cliIt.live(
    "agent list: exits 0",
    ({ opencode }) =>
      Effect.gen(function* () {
        const r = yield* opencode.spawn(["agent", "list"], { timeoutMs })
        opencode.expectExit(r, 0, "agent list")
      }),
    testTimeoutMs,
  )

  // `session list` reads the session DB. Fresh OPENCODE_TEST_HOME means
  // empty DB. Exit 0 with no sessions.
  cliIt.live(
    "session list: exits 0",
    ({ opencode }) =>
      Effect.gen(function* () {
        const r = yield* opencode.spawn(["session", "list"], { timeoutMs })
        opencode.expectExit(r, 0, "session list")
      }),
    testTimeoutMs,
  )

  // `stats` aggregates token usage from the session DB. Empty DB → all zeros.
  cliIt.live(
    "stats: exits 0",
    ({ opencode }) =>
      Effect.gen(function* () {
        const r = yield* opencode.spawn(["stats"], { timeoutMs })
        opencode.expectExit(r, 0, "stats")
      }),
    testTimeoutMs,
  )

  // `db path` prints either SQLite's `:memory:` or the isolated fixture's
  // OPENCODE_DB file. Accept both without assuming a POSIX path shape.
  cliIt.live(
    "db path: exits 0 and prints a path or :memory:",
    ({ opencode }) =>
      Effect.gen(function* () {
        const r = yield* opencode.spawn(["db", "path"], { timeoutMs })
        opencode.expectExit(r, 0, "db path")
        const output = r.stdout.trim()
        if (output === ":memory:") return
        expect(path.isAbsolute(output)).toBe(true)
        expect([".db", ".sqlite", ".sqlite3"]).toContain(path.extname(output).toLowerCase())
      }),
    testTimeoutMs,
  )
})
