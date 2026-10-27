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
import { crc32, gzipSync } from "zlib"
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

// Builds a fake release asset in memory and an HTTP handler that serves it, so
// the real upgrade flow (download -> checksum -> extract -> rename) runs
// against a constructed archive with a known sha256. The archive is written
// with node's zlib instead of the `tar` CLI (CI's Windows runners have no
// usable tar for C:\... paths — it parses the drive letter as a remote host),
// and matches the real asset layout per platform: tar.gz everywhere, zip on
// win32 (same as the fork-release workflow's matrix).
function fakeReleaseHandler(options: { corrupt?: boolean }) {
  const platform = process.platform === "win32" ? "windows" : "linux"
  const extension = process.platform === "win32" ? ".zip" : ".tar.gz"
  const name = `fmcode-${platform}-${process.arch}${extension}`
  const entries: Array<{ name: string; content: Buffer; mode: number }> = [
    { name: `${name.replace(extension, "")}/bin/fmcode`, content: Buffer.from("#!/bin/sh\n"), mode: 0o755 },
    { name: `${name.replace(extension, "")}/bin/rg`, content: Buffer.from("#!/bin/sh\n"), mode: 0o755 },
    { name: `${name.replace(extension, "")}/package.json`, content: Buffer.from("{}"), mode: 0o644 },
  ]
  const bytes =
    extension === ".zip"
      ? zipSync(entries)
      : gzipSync(
          Buffer.concat([
            ...entries.map((entry) => tarEntry(entry.name, entry.content, entry.mode)),
            Buffer.alloc(1024), // two zero blocks terminate a ustar stream
          ]),
        )
  let hash = createHash("sha256").update(bytes).digest("hex")
  if (options.corrupt) hash = "0".repeat(64)
  const body = new Uint8Array(bytes)
  return (request: HttpClientRequest.HttpClientRequest) => {
    const url = request.url
    if (url.endsWith(`/${name}`)) return new Response(body)
    if (url.endsWith("/sha256sums.txt")) return new Response(`${hash}  ${name}\n`)
    return new Response("not found", { status: 404 })
  }
}

// Minimal ustar writer: one 512-byte header + 512-padded content per file,
// terminated by two zero blocks. Only regular files with short names are
// needed; the runtime extraction shells out to the system tar.
function tarEntry(name: string, content: Buffer, mode: number): Buffer {
  const header = Buffer.alloc(512)
  header.write(name.slice(0, 100), 0)
  header.write(mode.toString(8).padStart(7, "0") + "\0", 100)
  header.write("0000000\0", 108) // uid
  header.write("0000000\0", 116) // gid
  header.write(content.length.toString(8).padStart(11, "0") + "\0", 124) // size
  header.write("00000000000\0", 136) // mtime
  header.write("        ", 148) // checksum placeholder (spaces)
  header.write("0", 156) // regular file
  header.write("ustar\0", 257)
  header.write("00", 263)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148)
  return Buffer.concat([header, content, Buffer.alloc((512 - (content.length % 512)) % 512)])
}

// Minimal stored (uncompressed) zip writer: local file headers + central
// directory. CRC-32 comes from zlib.
function zipSync(entries: Array<{ name: string; content: Buffer; mode: number }>): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name)
    const crc = crc32(entry.content)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.content.length, 18)
    local.writeUInt32LE(entry.content.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    // External attrs: (mode << 16) | 0 marks a regular file with unix mode.
    const external = (entry.mode << 16) | 0
    parts.push(local, nameBytes, entry.content)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(0x0800, 8)
    dir.writeUInt16LE(0, 10)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(entry.content.length, 20)
    dir.writeUInt32LE(entry.content.length, 24)
    dir.writeUInt16LE(nameBytes.length, 28)
    dir.writeUInt32LE(external, 38)
    dir.writeUInt32LE(offset, 42)
    central.push(dir, nameBytes)
    offset += local.length + nameBytes.length + entry.content.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, directory, end])
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
            // The install prefix is built with path.join, so its separators
            // follow the runner's platform (backslashes on win32); keep the
            // fixture in the same form instead of forcing POSIX slashes.
            Object.defineProperty(process, "execPath", {
              value: path.resolve(path.sep, path.join(".fmcode", "bin", "fmcode")),
              configurable: true,
            })
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
