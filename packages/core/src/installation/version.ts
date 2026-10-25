declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
  const OPENCODE_PLUGIN_SDK_VERSION: string
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"

// The @opencode-ai/plugin version shipped inside this binary, injected at build
// time from packages/plugin/package.json. Config directories pin this instead of
// the host version (issue #67): the fork's own version does not exist on npm,
// and as long as packages/plugin matches its declared version, installing it
// yields the same SDK code the binary carries.
export const PluginSdkVersion = typeof OPENCODE_PLUGIN_SDK_VERSION === "string" ? OPENCODE_PLUGIN_SDK_VERSION : "latest"
