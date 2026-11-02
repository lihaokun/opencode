#!/usr/bin/env bun
// Plugin SDK drift check (issue #67, acceptance item 4).
//
// The binary installs `@opencode-ai/plugin@<version>` from npm — with
// <version> read from packages/plugin/package.json at build time — while the
// host runtime carries the repo's `packages/plugin/src` compiled in. Those two
// copies are only the same code while the repo sources still compile to
// exactly what the pinned npm version ships. This check verifies that
// invariant; a source edit without a version bump makes it fail.
//
// Remedy when it fails: revert the source change, or bump the version (only
// possible if the new version is publishable), or ship the SDK inside the
// binary (issue #67, option 3).
//
// Run: bun script/check-plugin-drift.ts   (from repo root)
import { $ } from "bun"
import path from "node:path"
import fs from "node:fs/promises"
import os from "node:os"

const root = path.resolve(import.meta.dir, "..")
const pluginDir = path.join(root, "packages/plugin")

const pkg = JSON.parse(await Bun.file(path.join(pluginDir, "package.json")).text()) as {
  name: string
  version: string
}
console.log(`checking ${pkg.name}: repo sources vs npm@${pkg.version}`)

// Scratch space lives OUTSIDE the compiled tree so the content diff below
// never sees its own scaffolding.
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-drift-"))
try {
  // 1. Compile the repo sources the same way the publish script does.
  // `bun tsc --outDir <dir>` emits the rootDir (src/) contents directly into
  // <dir>, so the compiled tree sits at the top level.
  const compiled = path.join(scratch, "compiled")
  const tsc = await $`bun tsc --outDir ${compiled}`.cwd(pluginDir).nothrow()
  if (tsc.exitCode !== 0) {
    console.error(tsc.stderr.toString() || tsc.stdout.toString())
    console.error(`FAIL: tsc failed for packages/plugin`)
    process.exit(1)
  }

  // 2. Fetch the published tarball for the pinned version.
  const packed = await $`npm pack ${pkg.name}@${pkg.version} --json`.nothrow().cwd(scratch)
  if (packed.exitCode !== 0) {
    console.error(packed.stderr.toString())
    console.error(`FAIL: cannot fetch ${pkg.name}@${pkg.version} from npm — the pinned version must exist and match`)
    process.exit(1)
  }
  const tarball = (JSON.parse(packed.stdout.toString()) as { filename: string }[])[0]?.filename
  if (!tarball) {
    console.error("FAIL: npm pack returned no tarball")
    process.exit(1)
  }
  const extractDir = path.join(scratch, "extracted")
  await fs.mkdir(extractDir, { recursive: true })
  await $`tar -xzf ${path.join(scratch, tarball)} -C ${extractDir}`.quiet().nothrow()

  // 3. Content-compare the compiled output against the published dist/.
  const published = path.join(extractDir, "package", "dist")
  const diff = await $`diff -rq ${compiled} ${published}`.nothrow()
  if (diff.exitCode !== 0) {
    console.error(diff.stdout.toString())
    console.error(
      `FAIL: packages/plugin differs from ${pkg.name}@${pkg.version} on npm without a version bump.\n` +
        `  The binary installs the npm copy while the host runs the repo copy — behavior would silently diverge.\n` +
        `  Either revert the change, bump the version in packages/plugin/package.json, or ship the SDK in the binary (issue #67 option 3).`,
    )
    process.exit(1)
  }
  console.log(`OK: repo sources compile to exactly ${pkg.name}@${pkg.version}`)
} finally {
  await fs.rm(scratch, { recursive: true, force: true })
}
