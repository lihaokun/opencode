import { describe, expect } from "bun:test"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

const encoder = new TextEncoder()

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

function mockSpawner(
  handler: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string } = () =>
    "",
) {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    const result = handler(std?.command ?? "", std?.args ?? [])
    const output = typeof result === "string" ? { code: 0, stdout: result, stderr: "" } : result
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output.stdout ? Stream.make(encoder.encode(output.stdout)) : Stream.empty,
        stderr: output.stderr ? Stream.make(encoder.encode(output.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function testLayer(
  httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response,
  spawnHandler?: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string },
) {
  const spawnerNode = makeGlobalNode({
    service: ChildProcessSpawner.ChildProcessSpawner,
    layer: mockSpawner(spawnHandler),
    deps: [],
  })
  return LayerNode.compile(Installation.node, [
    [httpClient, mockHttpClient(httpHandler)],
    [CrossSpawnSpawner.node, spawnerNode],
  ])
}

describe("installation", () => {
  describe("latest", () => {
    testEffect(testLayer(() => jsonResponse({ tag_name: "v1.2.3" }))).effect(
      "reads release version from GitHub releases",
      () =>
        Effect.gen(function* () {
          const result = yield* Installation.use.latest("curl")
          expect(result).toBe("1.2.3")
        }),
    )

    testEffect(testLayer(() => jsonResponse({ tag_name: "v4.0.0-beta.1" }))).effect(
      "strips v prefix from GitHub release tag",
      () =>
        Effect.gen(function* () {
          const result = yield* Installation.use.latest("unknown")
          expect(result).toBe("4.0.0-beta.1")
        }),
    )

    const ghCalls: string[] = []
    testEffect(
      testLayer((request) => {
        ghCalls.push(request.url)
        return jsonResponse({ tag_name: "v9.9.9" })
      }),
    ).effect("queries the fork's releases/latest regardless of method", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("curl")
        expect(result).toBe("9.9.9")
        expect(ghCalls).toContain("https://api.github.com/repos/lihaokun/opencode/releases/latest")
      }),
    )

    testEffect(
      testLayer((request) => {
        ghCalls.push(request.url)
        return jsonResponse({ tag_name: "v9.9.9" })
      }),
    ).effect("ignores the method argument (single distribution channel)", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("unknown")
        expect(result).toBe("9.9.9")
        expect(ghCalls.every((url) => url.includes("repos/lihaokun/opencode/releases/latest"))).toBe(true)
      }),
    )
  })

  describe("upgrade", () => {
    testEffect(testLayer(() => jsonResponse({ tag_name: "v1.0.0" }))).effect(
      "is a stub that defers to the release page until #65",
      () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(Installation.use.upgrade("curl", "9.9.9"))
          expect(error).toBeInstanceOf(Installation.UpgradeNotSupportedError)
          expect(error.message).toContain("https://github.com/lihaokun/opencode/releases/latest")
        }),
    )

    testEffect(testLayer(() => jsonResponse({ tag_name: "v1.0.0" }))).effect(
      "stub applies to every method",
      () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(Installation.use.upgrade("unknown", "9.9.9"))
          expect(error).toBeInstanceOf(Installation.UpgradeNotSupportedError)
        }),
    )
  })

  describe("method", () => {
    testEffect(testLayer(() => jsonResponse({ tag_name: "v1.0.0" }))).effect(
      "reports curl for .fmcode/bin installs",
      () =>
        Effect.gen(function* () {
          const original = process.execPath
          try {
            Object.defineProperty(process, "execPath", { value: "/home/u/.fmcode/bin/fmcode", configurable: true })
            expect(yield* Installation.use.method()).toBe("curl")
          } finally {
            Object.defineProperty(process, "execPath", { value: original, configurable: true })
          }
        }),
    )

    testEffect(testLayer(() => jsonResponse({ tag_name: "v1.0.0" }))).effect(
      "reports unknown for local dev builds",
      () =>
        Effect.gen(function* () {
          const original = process.execPath
          try {
            Object.defineProperty(process, "execPath", { value: "/home/u/workspace/fmcode/build/fmcode", configurable: true })
            expect(yield* Installation.use.method()).toBe("unknown")
          } finally {
            Object.defineProperty(process, "execPath", { value: original, configurable: true })
          }
        }),
    )
  })
})
