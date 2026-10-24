#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"

const opencode = path.resolve(dir, "../../opencode")

await $`bun dev generate > ${dir}/openapi.json`.cwd(opencode)

const document = (await Bun.file("./openapi.json").json()) as {
  components?: { schemas?: Record<string, unknown> }
  [key: string]: unknown
}
const schemas = document.components?.schemas
if (schemas) {
  const reachable = new Set<string>()
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (typeof value !== "object" || value === null) return
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string" && child.startsWith("#/components/schemas/")) {
        const name = child.slice("#/components/schemas/".length)
        if (reachable.has(name)) continue
        reachable.add(name)
        visit(schemas[name])
      } else {
        visit(child)
      }
    }
  }
  visit({ ...document, components: { ...document.components, schemas: undefined } })
  for (const name of Object.keys(schemas)) {
    if (/^SessionNext\w+1$/.test(name) && !reachable.has(name)) delete schemas[name]
  }
  await Bun.write("./openapi.json", JSON.stringify(document))
}

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "OpencodeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

const generatedTypes = await Bun.file("./src/v2/gen/types.gen.ts").text()
if (/export type SessionNext\w+1 =/.test(generatedTypes)) {
  throw new Error("Session history generated duplicate Session event variants")
}
// The numeric-query patch targets the V2 history endpoints. When the spec no
// longer carries them (the /api rail was removed from the embedded server),
// there is nothing to patch and the generated types are used as-is.
const hasV2History = generatedTypes.includes("export type V2SessionHistoryData =")
const historyTypesPatched = hasV2History
  ? generatedTypes.replace(
      /(export type V2SessionHistoryData = \{[\s\S]*?query\?: \{\s*limit\?: )string([;,]\s*after\?: )string/,
      "$1number$2number",
    )
  : generatedTypes
if (hasV2History && historyTypesPatched === generatedTypes) {
  throw new Error("Session history numeric query patch did not apply")
}
await Bun.write("./src/v2/gen/types.gen.ts", historyTypesPatched)

const generatedSdk = await Bun.file("./src/v2/gen/sdk.gen.ts").text()
const hasV2HistorySdk = generatedSdk.includes("Get session history")
const historySdkPatched = hasV2HistorySdk
  ? generatedSdk.replace(
      /(Get session history[\s\S]*?parameters: \{\s*sessionID: string[;,]\s*limit\?: )string([;,]\s*after\?: )string/,
      "$1number$2number",
    )
  : generatedSdk
if (hasV2HistorySdk && historySdkPatched === generatedSdk) {
  throw new Error("Session history numeric SDK patch did not apply")
}
await Bun.write("./src/v2/gen/sdk.gen.ts", historySdkPatched)

// Re-export the hand-maintained domain types (plugin author API contracts that
// outlive the generated OpenAPI surface) through the generated types module so
// `@opencode-ai/sdk/v2/types` keeps exposing them.
const typesWithDomain = historyTypesPatched.endsWith("\n") ? historyTypesPatched : historyTypesPatched + "\n"
const domainLine = `export * from "../domain.js"`
if (!typesWithDomain.includes(domainLine)) {
  await Bun.write("./src/v2/gen/types.gen.ts", typesWithDomain + domainLine + "\n")
}

// Patch a @hey-api/openapi-ts codegen bug: SseFn incorrectly passes the
// endpoint's TError into the second generic of ServerSentEventsResult, which
// is the AsyncGenerator's TReturn slot. Iterator return values have nothing
// to do with HTTP errors, and any consumer that calls `.return()` or returns
// from a mock generator gets type-checked against the wrong shape. Drop the
// arg so TReturn defaults to void.
const sseTypesPath = "./src/v2/gen/client/types.gen.ts"
const sseTypesFile = Bun.file(sseTypesPath)
const sseTypesSource = await sseTypesFile.text()
const sseTypesPatched = sseTypesSource.replace(
  "=> Promise<ServerSentEventsResult<TData, TError>>",
  "=> Promise<ServerSentEventsResult<TData>>",
)
if (sseTypesPatched === sseTypesSource) {
  throw new Error(`SseFn patch did not apply; @hey-api/openapi-ts output may have changed (${sseTypesPath})`)
}
await Bun.write(sseTypesPath, sseTypesPatched)

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`rm -rf dist`
await $`rm -f openapi.json`
// The generated surface makes tsc's recursive type walkers run deep; the
// default stack overflows on constrained runners (observed as
// getQuickTypeOfExpression RangeError under CI parallelism). NODE_OPTIONS
// rejects --stack-size, so hand the flag to the node binary that hosts tsc.
// Resolve the script from this package (the store layout differs per platform,
// so a literal node_modules path breaks on Windows CI).
const { createRequire } = await import("node:module")
const tscPath = createRequire(import.meta.url).resolve("typescript/bin/tsc")
await $`bun x node --stack-size=8192 ${tscPath}`
await $`rm -f openapi.json`
