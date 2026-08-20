import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { FilePaths } from "../../src/server/routes/instance/httpapi/groups/file"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(httpApiLayer)

function request(route: string, directory: string, query?: Record<string, string>) {
  const url = new URL(`http://localhost${route}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value)
  }
  return requestInDirectory(`${url.pathname}${url.search}`, directory)
}

describe("file HttpApi", () => {
  it.instance(
    "serves read endpoints",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        yield* Effect.promise(() => Bun.write(path.join(tmp.directory, "hello.txt"), "hello"))

        const list = yield* request(FilePaths.list, tmp.directory, { path: "." })
        const content = yield* request(FilePaths.content, tmp.directory, { path: "hello.txt" })
        const status = yield* request(FilePaths.status, tmp.directory)

        expect(list.status).toBe(200)
        expect(yield* list.json).toContainEqual(
          expect.objectContaining({ name: "hello.txt", path: "hello.txt", type: "file" }),
        )

        expect(content.status).toBe(200)
        expect(yield* content.json).toMatchObject({ type: "text", content: "hello" })

        expect(status.status).toBe(200)
        expect(yield* status.json).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves search endpoints",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        yield* Effect.promise(() => Bun.write(path.join(tmp.directory, "hello.txt"), "needle"))

        const text = yield* request(FilePaths.findText, tmp.directory, { pattern: "needle" })
        const symbols = yield* request(FilePaths.findSymbol, tmp.directory, { query: "hello" })
        const files = yield* request(FilePaths.findFile, tmp.directory, { query: "hello", type: "file" })

        expect(text.status).toBe(200)
        expect(yield* text.json).toContainEqual(expect.objectContaining({ line_number: 1 }))

        expect(files.status).toBe(200)
        expect(yield* files.json).toContain("hello.txt")

        expect(symbols.status).toBe(200)
        expect(yield* symbols.json).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
    60_000,
  )
})
