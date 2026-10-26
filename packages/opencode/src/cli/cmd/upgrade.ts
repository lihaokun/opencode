import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Installation } from "../../installation"

export const UpgradeCommand = {
  command: "upgrade [target]",
  describe: "check for a new fmcode release (self-upgrade arrives with in-process replacement)",
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
    const target = args.target ? args.target.replace(/^v/, "") : await Installation.latest(method)

    if (InstallationVersion === target) {
      prompts.log.warn(`fmcode upgrade skipped: ${target} is already installed`)
      prompts.outro("Done")
      return
    }

    prompts.log.info(`Installed: ${InstallationVersion}`)
    prompts.log.info(`Latest release: ${target}`)

    const err: unknown = await Installation.upgrade(method, target).catch((err) => err)
    if (err instanceof Installation.UpgradeNotSupportedError) {
      prompts.log.warn(err.message)
    } else if (err instanceof Error) {
      prompts.log.error(err.message)
    }
    prompts.outro("Done")
  },
}
