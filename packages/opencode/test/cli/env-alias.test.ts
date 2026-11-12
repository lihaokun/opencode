// Unit test: import-time alias behavior via subprocess (ESM import-time side effect)
import { describe, expect, it } from "bun:test"
import path from "path"

const run = (env: Record<string, string>, code: string) => {
  const proc = Bun.spawnSync({
    cmd: ["bun", "-e", code],
    env: { ...process.env, ...env },
    cwd: path.join(import.meta.dir, "..", ".."),
    stdout: "pipe",
  })
  return proc.stdout.toString().trim()
}

describe("env-alias (import-time side effect)", () => {
  it("copies set FCODE_X to unset OPENCODE_X", () => {
    const out = run(
      { FCODE_LOG_LEVEL: "DEBUG", OPENCODE_LOG_LEVEL: undefined as unknown as string },
      `import "./src/env-alias"; console.log(process.env.OPENCODE_LOG_LEVEL)`,
    ).trim()
    expect(out).toBe("DEBUG")
  })

  it("explicit OPENCODE_X wins, alias skipped", () => {
    const out = run(
      { FCODE_LOG_LEVEL: "DEBUG", OPENCODE_LOG_LEVEL: "INFO" },
      `import "./src/env-alias"; console.log(process.env.OPENCODE_LOG_LEVEL)`,
    ).trim()
    expect(out).toBe("INFO")
  })

  it("unset FCODE leaves OPENCODE untouched", () => {
    const out = run(
      { OPENCODE_LOG_LEVEL: "WARN" },
      `import "./src/env-alias"; console.log(process.env.OPENCODE_LOG_LEVEL)`,
    ).trim()
    expect(out).toBe("WARN")
  })

  it("keys outside the alias list are not copied", () => {
    const out = run(
      { FCODE_VERSION: "9.9.9" },
      `import "./src/env-alias"; console.log(process.env.OPENCODE_VERSION ?? "unset")`,
    ).trim()
    expect(out).toBe("unset")
  })
})

// Alignment: every user-facing flag.ts key must be reachable through the
// alias table. The architecture doc promised a mechanical check that never
// existed; without one the list silently drifts (it already had — four keys
// were absent). Exclusions must be justified here, not just omitted.
describe("env-alias alignment with flag.ts", () => {
  // Process-internal identity/machinery, not user configuration: the entry
  // client label (set programmatically by acp.ts/desktop), the plugin meta
  // cache file override (internal state plumbing), the pure-mode switch
  // (set by our own index.ts), and the workspace correlation id (set by the
  // control plane). None of these is a setting a user writes in their shell.
  const EXCLUDED = new Set([
    "OPENCODE_CLIENT",
    "OPENCODE_PLUGIN_META_FILE",
    "OPENCODE_PURE",
    "OPENCODE_WORKSPACE_ID",
  ])

  it("covers every flag.ts key except the documented exclusions", async () => {
    const flagSource = await Bun.file(
      path.join(import.meta.dir, "..", "..", "..", "core", "src", "flag", "flag.ts"),
    ).text()
    const flagKeys = [...new Set([...flagSource.matchAll(/"?(OPENCODE_[A-Z_0-9]+)"?/g)].map((m) => m[1]!))].filter(
      (key) => !key.startsWith("OPENCODE_TEST_"),
    )
    expect(flagKeys.length).toBeGreaterThan(20)

    const aliasSource = await Bun.file(path.join(import.meta.dir, "..", "..", "src", "env-alias.ts")).text()
    const aliasTargets = new Set([...aliasSource.matchAll(/"(OPENCODE_[A-Z_0-9]+)"\s*\]/g)].map((m) => m[1]!))

    const missing = flagKeys.filter((key) => !aliasTargets.has(key) && !EXCLUDED.has(key))
    expect(missing).toEqual([])
    // And the exclusion list must not grow stale either.
    const stale = [...EXCLUDED].filter((key) => !flagKeys.includes(key))
    expect(stale).toEqual([])
  })
})
