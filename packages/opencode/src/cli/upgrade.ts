import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Installation } from "@/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { GlobalBus } from "@/bus/global"
import { compareVersion, parseVersion } from "@/installation/version-compare"

export async function upgrade() {
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  if (config.autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE) return

  // The channel is decided by the running version alone (no cross-channel
  // config): stable follows stable, beta follows beta. Unparseable versions
  // (local/PR builds) never check.
  const current = parseVersion(InstallationVersion)
  if (!current) return
  const latest = await Installation.latest(current.channel).catch(() => undefined)
  if (!latest) return
  const parsed = parseVersion(latest)
  if (!parsed) return

  // Guard: only a strictly newer release acts (never downgrade, never reinstall).
  if (compareVersion(parsed, current) <= 0) return

  const kind = Installation.getReleaseType(InstallationVersion, latest)

  // Auto-install eligibility: autoupdate === true and a same-baseline patch.
  // Everything else (baseline change, "notify", anything not true) only notifies.
  if (config.autoupdate === true && kind === "patch") {
    const method = await Installation.method().catch(() => undefined)
    if (!method) return
    await Installation.upgrade(method, latest)
      .then(() =>
        GlobalBus.emit("event", {
          directory: "global",
          payload: {
            type: Installation.Event.Updated.type,
            properties: { version: latest },
          },
        }),
      )
      .catch(() => {})
    return
  }

  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: Installation.Event.UpdateAvailable.type,
      properties: { version: latest },
    },
  })
}
