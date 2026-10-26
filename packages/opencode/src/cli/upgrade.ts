import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Installation } from "@/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { GlobalBus } from "@/bus/global"

export async function upgrade() {
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  if (config.autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE) return
  const method = await Installation.method().catch(() => undefined)
  if (!method) return
  const latest = await Installation.latest(method).catch(() => {})
  if (!latest) return

  if (InstallationVersion === latest) return

  // Self-upgrade is a stub until #65 lands in-process replacement — the fork
  // never executes an install from here (the old curl path ran upstream's
  // installer and would replace the fork with the official build). Notify only.
  const kind = Installation.getReleaseType(InstallationVersion, latest)

  if (config.autoupdate === "notify" || Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE || kind !== "patch") {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
  }
}
