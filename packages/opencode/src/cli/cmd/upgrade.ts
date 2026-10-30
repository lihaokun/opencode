import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Installation } from "../../installation"
import { compareVersion, parseVersion } from "../../installation/version-compare"

export const UpgradeCommand = {
  command: "upgrade [target]",
  describe: "upgrade fmcode to the latest or a specific release",
  builder: (yargs: Argv) => {
    return yargs.positional("target", {
      describe: "version to upgrade to, for ex '1.18.31-fmv2.1' or 'v1.18.31-fmv2.1'",
      type: "string",
    })
  },
  handler: async (args: { target?: string }) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Upgrade")
    const method = await Installation.method()
    if (method === "unknown") {
      prompts.log.warn("fmcode was not installed from a release; self-upgrade is unavailable")
      prompts.outro("Done")
      return
    }

    const target = args.target
      ? args.target.replace(/^v/, "")
      : await Installation.latest(parseVersion(InstallationVersion)?.channel ?? "stable")

    const parsed = parseVersion(target)
    if (!parsed) {
      prompts.log.error(`unknown version format: ${target}`)
      prompts.outro("Done")
      return
    }

    // Manual command: an explicit target is the user's instruction — downgrades
    // and cross-channel moves are allowed. Only the exact re-install of the
    // running version is skipped.
    if (!args.target && compareVersion(parsed, parseVersion(InstallationVersion) ?? parsed) <= 0) {
      prompts.log.warn(`fmcode upgrade skipped: ${target} is already installed`)
      prompts.outro("Done")
      return
    }

    prompts.log.info(`Installed: ${InstallationVersion}`)
    prompts.log.info(`Upgrading to: ${target}`)
    const spinner = prompts.spinner()
    spinner.start("Upgrading...")
    const err: unknown = await Installation.upgrade(method, target).catch((err) => err)
    if (err) {
      spinner.stop("Upgrade failed", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
      return
    }
    spinner.stop("Upgrade complete — restart fmcode to run the new version")
    prompts.outro("Done")
  },
}
