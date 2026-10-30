import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Cause, Exit, Effect, Layer, Schema, Context, Stream } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { errorMessage } from "@/util/error"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import path from "path"
import fs from "fs/promises"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import semver from "semver"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { InstallationEvent } from "@opencode-ai/schema/installation-event"
import { Archive } from "@/util/archive"
import { Process } from "@/util/process"
import { compareVersion, parseVersion } from "./version-compare"

// The fork ships exclusively via GitHub release downloads (fmcode-1-visible-rename):
// "curl" marks an install under ~/.fmcode/bin or ~/.local/bin. Every package
// manager path was removed — an unknown method (local dev build, npm install
// of the upstream package, etc.) cannot self-upgrade.
export type Method = "curl" | "unknown"

// Test/E2E seam: point the GitHub API and asset host at a local fake so the
// upgrade flow can run against constructed releases without leaving localhost.
const GITHUB_API = process.env["FMCODE_GITHUB_API"] ?? "https://api.github.com"
const GITHUB_DOWNLOAD = process.env["FMCODE_GITHUB_DOWNLOAD"] ?? "https://github.com"

export type ReleaseType = "patch" | "minor" | "major"

export const Event = InstallationEvent

export function getReleaseType(current: string, latest: string): ReleaseType {
  const currMajor = semver.major(current)
  const currMinor = semver.minor(current)
  const newMajor = semver.major(latest)
  const newMinor = semver.minor(latest)

  if (newMajor > currMajor) return "major"
  if (newMinor > currMinor) return "minor"
  return "patch"
}

export const Info = Schema.Struct({
  version: Schema.String,
  latest: Schema.String,
}).annotate({ identifier: "InstallationInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export function userAgent(client = "cli") {
  return `opencode/${InstallationChannel}/${InstallationVersion}/${client}`
}

export const USER_AGENT = userAgent()

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

// Response schemas for the fork's release API. /releases/latest excludes
// pre-releases and drafts, which is exactly the stable channel's semantics.
const GitHubRelease = Schema.Struct({ tag_name: Schema.String })
const GitHubReleaseList = Schema.Struct({
  tag_name: Schema.String,
  prerelease: Schema.Boolean,
})
export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {
  override get message() {
    return this.stderr
  }
}

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (channel: "stable" | "beta") => Effect.Effect<string, UpgradeFailedError>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<void, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Installation") {}

export const use = serviceUse(Service)

const fail = (message: string) => new UpgradeFailedError({ stderr: message })

const assetName = () => {
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux"
  const extension = process.platform === "win32" ? ".zip" : ".tar.gz"
  return `fmcode-${platform}-${process.arch}${extension}`
}

const layer: Layer.Layer<Service, never, HttpClient.HttpClient | AppProcess.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(withTransientReadRetry(http))
    const appProcess = yield* AppProcess.Service

    // Streams the body to disk — release assets are tens of MB and must not be
    // buffered in memory. Deletes the partial file when the stream breaks.
    const downloadToFile = Effect.fn("Installation.downloadToFile")(function* (url: string, dest: string) {
      const response = yield* httpOk.execute(HttpClientRequest.get(url)).pipe(
        Effect.mapError((error) => fail(`download failed: ${errorMessage(error)}`)),
      )
      const writer = Bun.file(dest).writer()
      let written = 0
      const pumped = response.stream.pipe(
        Stream.map((chunk: Uint8Array) => {
          void writer.write(chunk)
          written += chunk.byteLength
          return chunk
        }),
        Stream.runDrain,
      )
      const drained = yield* Effect.exit(pumped)
      yield* Effect.promise(async () => {
        await writer.end()
      }).pipe(
        Effect.mapError(() => fail(`cannot close ${dest}`)),
      )
      if (Exit.isFailure(drained)) {
        yield* Effect.promise(() => fs.rm(dest, { force: true })).pipe(Effect.ignore)
        const cause = Cause.squash(drained.cause)
        return yield* fail(`download failed: ${errorMessage(cause)}`)
      }
      if (written === 0) {
        yield* Effect.promise(() => fs.rm(dest, { force: true })).pipe(Effect.ignore)
        return yield* fail("download was empty")
      }
    })

    const latestStable = Effect.fn("Installation.latestStable")(function* () {
      const response = yield* httpOk.execute(
        HttpClientRequest.get(`${GITHUB_API}/repos/lihaokun/opencode/releases/latest`).pipe(
          HttpClientRequest.acceptJson,
        ),
      )
      const data = yield* HttpClientResponse.schemaBodyJson(GitHubRelease)(response)
      return data.tag_name.replace(/^v/, "")
    })

    const latestBeta = Effect.fn("Installation.latestBeta")(function* () {
      const response = yield* httpOk.execute(
        HttpClientRequest.get(`${GITHUB_API}/repos/lihaokun/opencode/releases?per_page=100`).pipe(
          HttpClientRequest.acceptJson,
        ),
      )
      const data = yield* HttpClientResponse.schemaBodyJson(Schema.Array(GitHubReleaseList))(response)
      // The tag grammar (-beta.<k>) is the gate; the prerelease flag is only an
      // auxiliary filter — the workflow adds --prerelease on later creates, so
      // historical entries may lack it.
      const betas = data
        .map((release) => ({ tag: release.tag_name, parsed: parseVersion(release.tag_name) }))
        .filter((item): item is { tag: string; parsed: NonNullable<ReturnType<typeof parseVersion>> } =>
          item.parsed?.channel === "beta",
        )
      if (betas.length === 0) {
        return yield* fail("no beta release found")
      }
      const max = betas.reduce((acc, item) => (compareVersion(item.parsed, acc.parsed) === 1 ? item : acc))
      return max.tag.replace(/^v/, "")
    })

    const result: Interface = {
      info: Effect.fn("Installation.info")(function* () {
        return {
          version: InstallationVersion,
          latest: yield* result.latest("stable").pipe(Effect.orDie),
        }
      }),
      method: Effect.fn("Installation.method")(function* () {
        if (process.execPath.includes(path.join(".fmcode", "bin"))) return "curl" as Method
        if (process.execPath.includes(path.join(".local", "bin"))) return "curl" as Method
        return "unknown" as Method
      }),
      latest: Effect.fn("Installation.latest")(function* (channel: "stable" | "beta") {
        return yield* (channel === "stable" ? latestStable() : latestBeta()).pipe(
          Effect.catch((error) =>
            error instanceof UpgradeFailedError
              ? Effect.fail(error)
              : Effect.fail(fail(`cannot read releases: ${errorMessage(error)}`)),
          ),
        )
      }),
      upgrade: Effect.fn("Installation.upgrade")(function* (method: Method, target: string) {
        if (method !== "curl") {
          return yield* fail("local builds cannot self-upgrade; install a release from https://github.com/lihaokun/opencode/releases")
        }
        const version = parseVersion(target)
        if (!version) {
          return yield* fail(`unknown version format: ${target}`)
        }
        const binDir = path.dirname(process.execPath)
        const stagingDir = path.join(binDir, `.staging-${target}`)
        const asset = assetName()
        const cleanup = Effect.promise(async () => {
          await fs.rm(stagingDir, { recursive: true, force: true })
        }).pipe(Effect.orDie, Effect.asVoid)

        yield* Effect.promise(async () => {
          await fs.mkdir(stagingDir, { recursive: true })
        }).pipe(
          Effect.mapError(() => fail(`cannot create staging directory in ${binDir}`)),
        )

        const downloaded = path.join(stagingDir, asset)
        yield* downloadToFile(
          `${GITHUB_DOWNLOAD}/lihaokun/opencode/releases/download/v${target}/${asset}`,
          downloaded,
        )

        // Checksum before anything else touches the live binary (I_3).
        const sums = yield* httpOk
          .execute(
            HttpClientRequest.get(
              `${GITHUB_DOWNLOAD}/lihaokun/opencode/releases/download/v${target}/sha256sums.txt`,
            ),
          )
          .pipe(
            Effect.flatMap((response) => response.text),
            Effect.mapError((error) => fail(`cannot download sha256sums.txt: ${errorMessage(error)}`)),
          )
        const line = sums
          .split("\n")
          .find((entry) => entry.trimEnd().endsWith(`  ${asset}`))
        if (!line) {
          yield* cleanup
          return yield* fail(`checksum entry for ${asset} not found in sha256sums.txt`)
        }
        const expected = line.trim().split(/\s+/)[0]
        // Checksum read is one-shot: the memory-sensitive part is the download
        // (streamed above); a transient ~40MB buffer for hashing is acceptable.
        const bytes = yield* Effect.promise(() => Bun.file(downloaded).arrayBuffer()).pipe(
          Effect.mapError(() => fail("cannot read downloaded asset for checksum")),
        )
        const hasher = new Bun.CryptoHasher("sha256")
        hasher.update(new Uint8Array(bytes))
        const actual = hasher.digest("hex")
        if (actual !== expected) {
          yield* cleanup
          return yield* fail(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`)
        }

        // Extract into staging (same directory tree as binDir => rename never
        // crosses a filesystem, so EXDEV cannot happen).
        const extract = Effect.promise(async () => {
          if (process.platform === "win32") {
            await Archive.extractZip(downloaded, stagingDir)
            return { code: 0, stderr: "" }
          }
          return Process.run(["tar", "-xzf", downloaded, "-C", stagingDir], { nothrow: true })
        }).pipe(
          Effect.mapError(() => fail("extraction failed")),
          Effect.flatMap((result) =>
            result.code !== 0
              ? Effect.fail(fail(`extraction failed: tar exited ${result.code}`))
              : Effect.void,
          ),
        )
        yield* extract

        // The asset extracts to <name>/ with bin/ and package.json inside; rename
        // everything into binDir (no whitelist — new bundled files come along).
        const entries = yield* Effect.promise(() => fs.readdir(stagingDir, { withFileTypes: true })).pipe(
          Effect.mapError(() => fail("staging directory unreadable")),
        )
        const topDir = path.join(stagingDir, entries.find((entry) => entry.isDirectory())?.name ?? "")
        const binDirStaged = path.join(topDir, "bin")
        const stagedBin = yield* Effect.promise(() => fs.readdir(binDirStaged).catch(() => [] as string[]))
        const executable = process.platform === "win32" ? "fmcode.exe" : "fmcode"
        if (!stagedBin.includes(executable) || !stagedBin.includes("rg")) {
          yield* cleanup
          return yield* fail("extracted release is missing the fmcode binary or rg")
        }

        // Replace: fmcode first (the binary users run), then the rest. On
        // Windows the running exe cannot be overwritten — park it as .old and
        // drop the new file in; the next run cleans the .old up.
        const moves: Array<[string, string]> = [
          [path.join(binDirStaged, executable), path.join(binDir, executable)],
          ...stagedBin
            .filter((name) => name !== executable)
            .map((name) => [path.join(binDirStaged, name), path.join(binDir, name)] as [string, string]),
        ]
        const rootPkg = path.join(topDir, "package.json")
        if (yield* Effect.promise(() => Bun.file(rootPkg).exists())) {
          moves.push([rootPkg, path.join(binDir, "package.json")])
        }

        if (process.platform === "win32") {
          const live = moves[0][1]
          yield* Effect.promise(() => fs.rename(live, `${live}.old`)).pipe(
            Effect.mapError(() => fail("cannot park the running executable (is another fmcode running?)")),
          )
        }
        for (const [index, [from, to]] of moves.entries()) {
          yield* Effect.promise(() => fs.rename(from, to)).pipe(
            Effect.mapError((error) => fail(`replacement failed (${String(error)}); rerun the upgrade`)),
          )
          // Defensive: the real assets carry 0755 on the binaries, but a packaging
          // regression that dropped the bit would otherwise brick the install.
          if (index < 2) {
            yield* Effect.promise(() => fs.chmod(to, 0o755)).pipe(Effect.orDie)
          }
        }

        // Non-critical cleanup: leftovers must not fail the upgrade.
        yield* cleanup
        yield* Effect.promise(async () => {
          await fs.rm(path.join(binDir, "fmcode.exe.old"), { force: true })
        }).pipe(Effect.orDie)
      }),
    }

    return Service.of(result)
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [httpClient, AppProcess.node] })

const { runPromise } = makeRuntime(Service, AppNodeBuilder.build(node))

export const latest = (...args: Parameters<Interface["latest"]>) => runPromise((s) => s.latest(...args))
export const method = () => runPromise((s) => s.method())
export const upgrade = (...args: Parameters<Interface["upgrade"]>) => runPromise((s) => s.upgrade(...args))

export * as Installation from "."

