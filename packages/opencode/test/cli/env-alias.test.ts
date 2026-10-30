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
  it("copies set FMCODE_X to unset OPENCODE_X", () => {
    const out = run(
      { FMCODE_LOG_LEVEL: "DEBUG", OPENCODE_LOG_LEVEL: undefined as unknown as string },
      `import "./src/env-alias"; console.log(process.env.OPENCODE_LOG_LEVEL)`,
    ).trim()
    expect(out).toBe("DEBUG")
  })

  it("explicit OPENCODE_X wins, alias skipped", () => {
    const out = run(
      { FMCODE_LOG_LEVEL: "DEBUG", OPENCODE_LOG_LEVEL: "INFO" },
      `import "./src/env-alias"; console.log(process.env.OPENCODE_LOG_LEVEL)`,
    ).trim()
    expect(out).toBe("INFO")
  })

  it("unset FMCODE leaves OPENCODE untouched", () => {
    const out = run(
      { OPENCODE_LOG_LEVEL: "WARN" },
      `import "./src/env-alias"; console.log(process.env.OPENCODE_LOG_LEVEL)`,
    ).trim()
    expect(out).toBe("WARN")
  })

  it("keys outside the alias list are not copied", () => {
    const out = run(
      { FMCODE_VERSION: "9.9.9" },
      `import "./src/env-alias"; console.log(process.env.OPENCODE_VERSION ?? "unset")`,
    ).trim()
    expect(out).toBe("unset")
  })
})
