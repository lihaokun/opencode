import { expect, test } from "bun:test"
import { FastCheck } from "effect/testing"
import { parse, type ParseError } from "jsonc-parser"
import path from "node:path"

const python = process.platform === "win32" ? "python" : "python3"
const driver = path.join(import.meta.dirname, "fork_install_test.py")

test("fork installer boundaries and installation flow", async () => {
  const child = Bun.spawn([python, driver], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code, output: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, output: "" })
}, 30_000)

test("fork installer config preservation, idempotence and numeric release selection properties", async () => {
  // Batch independent cases to avoid starting Python for every generated value.
  async function call(inputs: unknown[]) {
    const child = Bun.spawn([python, driver, "--properties"], {
      stdin: new Blob([inputs.map((input) => JSON.stringify(input) + "\n").join("")]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) throw new Error(stderr)
    return stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
  }
  await FastCheck.assert(
    FastCheck.asyncProperty(
      FastCheck.array(
        FastCheck.record({
          provider: FastCheck.jsonValue(),
          disabled: FastCheck.array(FastCheck.string(), { maxLength: 10 }),
          trailing: FastCheck.boolean(),
          present: FastCheck.boolean(),
        }),
        { minLength: 1, maxLength: 10 },
      ),
      async (cases) => {
        const inputs = cases.map((item) => {
          const original = {
            provider: item.provider,
            ...(item.present ? { autoupdate: true, disabled_providers: item.disabled } : {}),
            marker: "http://host/a/*not a comment*/ // ,}",
          }
          const text =
            "// retained header\n" + JSON.stringify(original, null, 2).replace(/\n}$/, `${item.trailing ? "," : ""}\n}`)
          return { kind: "config", text, disabled: item.disabled, original }
        })
        const results = await call(inputs)
        expect(results).toHaveLength(inputs.length)
        results.forEach((result, i) => {
          const errors: ParseError[] = []
          const value = parse(result.text, errors, { allowTrailingComma: true })
          expect(errors).toEqual([])
          expect(value).toEqual({
            ...inputs[i]!.original,
            autoupdate: false,
            disabled_providers: [...new Set([...inputs[i]!.disabled, "opencode", "opencode-go"])],
          })
          expect(result.text).toStartWith("// retained header\n")
          expect(result.again).toBe(result.text)
        })
      },
    ),
    { numRuns: 40, seed: 35100 },
  )
  await FastCheck.assert(
    FastCheck.asyncProperty(
      FastCheck.array(
        FastCheck.record({
          versions: FastCheck.uniqueArray(FastCheck.integer({ min: 0, max: 999 }), { minLength: 1, maxLength: 30 }),
          channel: FastCheck.constantFrom("stable", "beta"),
        }),
        { minLength: 1, maxLength: 10 },
      ),
      async (cases) => {
        const results = await call(
          cases.map((item) => ({
            kind: "release",
            channel: item.channel,
            releases: item.versions.flatMap((n) => [
              { tag_name: `v1.18.31-fmv3.${n}` },
              { tag_name: `v1.18.31-fmv3-beta.${n}`, prerelease: n % 2 === 0 },
              { tag_name: `v99.0.0-fmv${n}`, draft: true },
            ]),
          })),
        )
        expect(results).toHaveLength(cases.length)
        results.forEach((result, i) => {
          expect(result.tag_name).toBe(
            `v1.18.31-fmv3${cases[i]!.channel === "beta" ? "-beta" : ""}.${Math.max(...cases[i]!.versions)}`,
          )
        })
      },
    ),
    { numRuns: 40, seed: 35101 },
  )
}, 60_000)
