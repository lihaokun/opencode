// Domain types for the plugin author API. These describe V2-shaped entities
// (catalog, agents, integrations, references, skills) that plugins read through
// the host context. They are hand-maintained: the generated OpenAPI surface no
// longer carries the /api endpoints these were once derived from.

export type AgentColor = string | "primary" | "secondary" | "accent" | "success" | "warning" | "error" | "info"

export type AgentV2Info = {
  id: string
  model?: ModelRef
  request: ProviderRequest
  system?: string
  description?: string
  mode: "subagent" | "primary" | "all"
  hidden: boolean
  color?: AgentColor
  steps?: number
  permissions: PermissionV2Ruleset
}

export type CommandV2Info = {
  name: string
  template: string
  description?: string
  agent?: string
  model?: ModelRef
  subtask?: boolean
}

export type ConnectionCredentialInfo = {
  type: "credential"
  id: string
  label: string
}

export type ConnectionEnvInfo = {
  type: "env"
  name: string
}

export type ConnectionInfo = ConnectionCredentialInfo | ConnectionEnvInfo

export type FileSystemEntry = {
  path: string
  type: "file" | "directory"
}

export type ModelApi =
  | {
      id: string
      type: "aisdk"
      package: string
      url?: string
      settings?: {
        [key: string]: unknown
      }
    }
  | {
      id: string
      type: "native"
      url?: string
      settings: {
        [key: string]: unknown
      }
    }

export type ModelCapabilities = {
  tools: boolean
  input: Array<string>
  output: Array<string>
}

export type ModelCost = {
  tier?: {
    type: "context"
    size: number
  }
  input: number
  output: number
  cache: {
    read: number
    write: number
  }
}

export type ModelRef = {
  id: string
  providerID: string
  variant?: string
}

export type ModelV2Info = {
  id: string
  providerID: string
  family?: string
  name: string
  api: ModelApi
  capabilities: ModelCapabilities
  request: {
    headers: {
      [key: string]: string
    }
    body: {
      [key: string]: unknown
    }
    variant?: string
  }
  variants: Array<{
    id: string
    headers: {
      [key: string]: string
    }
    body: {
      [key: string]: unknown
    }
  }>
  time: {
    released: number
  }
  cost: Array<ModelCost>
  status: "alpha" | "beta" | "deprecated" | "active"
  enabled: boolean
  limit: {
    context: number
    input?: number
    output: number
  }
}

export type PermissionV2Effect = "allow" | "deny" | "ask"

export type PermissionV2Rule = {
  action: string
  resource: string
  effect: PermissionV2Effect
}

export type PermissionV2Ruleset = Array<PermissionV2Rule>

export type ProviderAisdk = {
  type: "aisdk"
  package: string
  url?: string
  settings?: {
    [key: string]: unknown
  }
}

export type ProviderApi = ProviderAisdk | ProviderNative

export type ProviderNative = {
  type: "native"
  url?: string
  settings: {
    [key: string]: unknown
  }
}

export type ProviderRequest = {
  headers: {
    [key: string]: string
  }
  body: {
    [key: string]: unknown
  }
}

export type ProviderV2Info = {
  id: string
  integrationID?: string
  name: string
  disabled?: boolean
  api: ProviderApi
  request: ProviderRequest
}

export type ReferenceGitSource = {
  type: "git"
  repository: string
  branch?: string
  description?: string
  hidden?: boolean
}

export type ReferenceLocalSource = {
  type: "local"
  path: string
  description?: string
  hidden?: boolean
}

export type SkillV2DirectorySource = {
  type: "directory"
  path: string
}

export type SkillV2EmbeddedSource = {
  type: "embedded"
  skill: SkillV2Info
}

export type SkillV2Info = {
  name: string
  description?: string
  slash?: boolean
  location: string
  content: string
}

export type SkillV2Source = SkillV2DirectorySource | SkillV2UrlSource | SkillV2EmbeddedSource

export type SkillV2UrlSource = {
  type: "url"
  url: string
}
