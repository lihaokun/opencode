import { describe, expect } from "bun:test"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { createHash } from "crypto"
import { gzipSync } from "zlib"
import fs from "fs"
import os from "os"
import path from "path"

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

// Builds a fake release asset on disk and an HTTP handler that serves it, so
// the real upgrade flow (download -> checksum -> extract -> rename) runs
// against a constructed tarball with a known sha256. The tarball is written
// with node's zlib instead of the `tar` CLI: CI's Windows runners have no
// usable tar for C:\... paths (it parses the drive letter as a remote host).
function fakeReleaseHandler(options: { corrupt?: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmcode-release-"))
  const name = `fmcode-linux-${process.arch}`
  const top = path.join(dir, name)
  fs.mkdirSync(path.join(top, "bin"), { recursive: true })
  fs.writeFileSync(path.join(top, "bin", "fmcode"), "#!/bin/sh\n", { mode: 0o755 })
  fs.writeFileSync(path.join(top, "bin", "rg"), "#!/bin/sh\n", { mode: 0o755 })
  fs.writeFileSync(path.join(top, "package.json"), "{}")
  const bytes = gzipSync(
    // ustar header + pax is overkill for the fixture: the runtime extraction
    // shells out to the system tar, which reads plain ustar fine.
    tarSync(dir, name),
  )
  let hash = createHash("sha256").update(bytes).digest("hex")
  if (options.corrupt) hash = "0".repeat(64)
  return (request: HttpClientRequest.HttpClientRequest) => {
    const url = request.url
    if (url.endsWith(`/${name}.tar.gz`)) return new Response(bytes)
    if (url.endsWith("/sha256sums.txt")) return new Response(`${hash}  ${name}.tar.gz\n`)
    return new Response("not found", { status: 404 })
  }
}

// Minimal ustar writer: one 512-byte header + 512-padded content per file,
// two zero blocks at the end. Only regular files with short names are needed.
function tarSync(root: string, topName: string): Buffer {
  const blocks: Buffer[] = []
  const add = (fullPath: string, arcPath: string) => {
    const content = fs.readFileSync(fullPath)
    const header = Buffer.alloc(512)
    header.write(arcPath.slice(0, 100), 0)
    header.write("0000644\0", 100) // mode
    header.write("0000000\0", 108) // uid
    header.write("0000000\0", 116) // gid
    header.write(content.length.toString(8).padStart(11, "0") + "\0", 124) // size
    header.write(Math.floor(fs.statSync(fullPath).mtimeMs / 1000).toString(8).padStart(11, "0") + "\0", 136)
    header.write("        ", 148) // checksum placeholder (spaces)
    header.write("0", 156) // regular file
    header.write("ustar\0", 257)
    header.write("00", 263)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148)
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512))
  }
  const walk = (dirPath: string, arcDir: string) => {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name)
      const arc = arcDir ? `${arcDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        const header = Buffer.alloc(512)
        header.write(arc.slice(0, 100), 0)
        header.write("0000755\0", 100)
        header.write("0000000\0", 108)
        header.write("0000000\0", 116)
        header.write("00000000000\0", 124)
        header.write("00000000000\0", 136)
        header.write("        ", 148)
        header.write("5", 156)
        header.write("ustar\0", 257)
        header.write("00", 263)
        let sum = 0
        for (const byte of header) sum += byte
        header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148)
        blocks.push(header)
        walk(full, arc)
      } else {
        add(full, arc)
      }
    }
  }
  walk(root, "")
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

function testLayer(httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const spawnerNode = makeGlobalNode({
    service: ChildProcessSpawner.ChildProcessSpawner,
    layer: mockSpawner(),
    deps: [],
  })
  return LayerNode.compile(Installation.node, [
    [httpClient, mockHttpClient(httpHandler)],
    [CrossSpawnSpawner.node, spawnerNode],
  ])
}

describe("installation", () => {
  describe("latest", () => {
    testEffect(testLayer(() => jsonResponse({ tag_name: "v1.2.3-fmv1" }))).effect(
      "stable channel reads releases/latest",
      () =>
        Effect.gen(function* () {
          const result = yield* Installation.use.latest("stable")
          expect(result).toBe("1.2.3-fmv1")
        }),
    )

    const betaReleases = [
      { tag_name: "v1.18.31-fmv3-beta.16", prerelease: true },
      // Legacy shape: prerelease flag missing but the tag is a beta — grammar wins.
      { tag_name: "v1.18.31-fmv3-beta.17", prerelease: false },
      { tag_name: "v1.18.31-fmv2.1", prerelease: false },
    ]
    testEffect(testLayer(() => jsonResponse(betaReleases))).effect(
      "beta channel picks the grammar-greatest beta, ignoring the flag and order",
      () =>
        Effect.gen(function* () {
          const result = yield* Installation.use.latest("beta")
          expect(result).toBe("1.18.31-fmv3-beta.17")
        }),
    )

    testEffect(testLayer(() => jsonResponse([{ tag_name: "v1.18.31-fmv2.1", prerelease: false }]))).effect(
      "beta channel fails when no beta exists",
      () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(Installation.use.latest("beta"))
          expect(error.stderr).toContain("no beta release")
        }),
    )
  })

  describe("upgrade", () => {
    testEffect(
      testLayer((request) => {
        // 200 with no line for our asset: the sums file exists but the asset
        // entry is absent (different-generation sums file).
        if (request.url.includes("sha256sums.txt")) return new Response("deadbeef  other-asset.tar.gz\n")
        return new Response("asset")
      }),
    ).effect("fails when the checksum entry is missing", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(Installation.use.upgrade("curl", "1.18.31-fmv2.1"))
        expect(error.stderr).toContain("checksum entry")
      }),
    )

    testEffect(
      testLayer((request) => {
        if (request.url.includes("sha256sums.txt")) return new Response("x", { status: 404 })
        return new Response("asset")
      }),
    ).effect("fails when the checksums file cannot be downloaded", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(Installation.use.upgrade("curl", "1.18.31-fmv2.1"))
        expect(error.stderr).toContain("cannot download sha256sums.txt")
      }),
    )

    testEffect(
      testLayer(fakeReleaseHandler({ corrupt: true })),
    ).effect("leaves the live binary untouched on checksum mismatch", () =>
      Effect.gen(function* () {
        const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "fmcode-live-"))
        const live = path.join(binDir, "fmcode")
        fs.writeFileSync(live, "#!/bin/sh\necho old\n", { mode: 0o755 })
        const original = process.execPath
        try {
          Object.defineProperty(process, "execPath", { value: live, configurable: true })
          const error = yield* Effect.flip(Installation.use.upgrade("curl", "1.18.31-fmv2.1"))
          expect(error.stderr).toContain("checksum mismatch")
          expect(fs.readFileSync(live, "utf8")).toContain("echo old")
          expect(fs.readdirSync(binDir).some((entry) => entry.startsWith(".staging-"))).toBe(false)
        } finally {
          Object.defineProperty(process, "execPath", { value: original, configurable: true })
          fs.rmSync(binDir, { recursive: true, force: true })
        }
      }),
    )
  })

  describe("method", () => {
    testEffect(testLayer(() => jsonResponse({ tag_name: "v1.0.0-fmv1" }))).effect(
      "reports curl for .fmcode/bin installs",
      () =>
        Effect.gen(function* () {
          const original = process.execPath
          try {
            Object.defineProperty(process, "execPath", { value: `/${path.join(".fmcode", "bin", "fmcode")}`.replaceAll("\\", "/"), configurable: true })
            expect(yield* Installation.use.method()).toBe("curl")
          } finally {
            Object.defineProperty(process, "execPath", { value: original, configurable: true })
          }
        }),
    )

    testEffect(testLayer(() => jsonResponse({ tag_name: "v1.0.0-fmv1" }))).effect(
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
