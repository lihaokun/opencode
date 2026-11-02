import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { FastCheck } from "effect/testing"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigMigrateV1 } from "@opencode-ai/core/v1/config/migrate"
import { PermissionV2 } from "@opencode-ai/core/permission"

describe("legacy editing tool permissions", () => {
  test.each([
    ["patch", true, "patch", "allow"],
    ["patch", false, "patch", "deny"],
    ["apply_patch", true, "apply_patch", "allow"],
    ["apply_patch", false, "apply_patch", "deny"],
    ["write", true, "edit", "allow"],
    ["write", false, "edit", "deny"],
    ["edit", true, "edit", "allow"],
    ["edit", false, "edit", "deny"],
  ] as const)("normalizes and migrates %s:%s", (tool, enabled, action, effect) => {
    const input = { tools: { [tool]: enabled } }
    expect(Schema.decodeUnknownSync(ConfigAgentV1.Info)(input).permission).toEqual({ [action]: effect })
    const migrated = ConfigMigrateV1.migrate(
      Schema.decodeUnknownSync(ConfigV1.Info)({ ...input, agent: { build: input } }),
    )
    const expected = [{ action, resource: "*", effect }]
    expect(migrated.permissions).toEqual(expected)
    expect(migrated.agents?.build?.permissions).toEqual(expected)
    expect(PermissionV2.evaluate("edit", "src/file.ts", migrated.permissions ?? []).effect).toBe(
      action === "edit" ? effect : "ask",
    )
  })

  test("preserves last write/edit rule and explicit path permissions for arbitrary mixed legacy tools", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.record({
          patch: FastCheck.boolean(),
          apply_patch: FastCheck.boolean(),
          edit: FastCheck.boolean(),
          write: FastCheck.boolean(),
        }),
        FastCheck.boolean(),
        FastCheck.constantFrom("allow", "deny", "ask"),
        (flags, writeLast, override) => {
          const tools = writeLast
            ? { patch: flags.patch, apply_patch: flags.apply_patch, edit: flags.edit, write: flags.write }
            : { patch: flags.patch, apply_patch: flags.apply_patch, write: flags.write, edit: flags.edit }
          const action = (writeLast ? flags.write : flags.edit) ? "allow" : "deny"
          const normalized = Schema.decodeUnknownSync(ConfigAgentV1.Info)({ tools })
          expect(normalized.permission).toEqual({
            patch: flags.patch ? "allow" : "deny",
            apply_patch: flags.apply_patch ? "allow" : "deny",
            edit: action,
          })
          const permission = { edit: { "allowed/**": override }, patch: "ask", apply_patch: "ask" } as const
          const explicit = Schema.decodeUnknownSync(ConfigAgentV1.Info)({ tools, permission })
          expect(explicit.permission).toEqual(permission)
          const migrated = ConfigMigrateV1.migrate(
            Schema.decodeUnknownSync(ConfigV1.Info)({ tools, permission, agent: { build: { tools, permission } } }),
          )
          for (const rules of [migrated.permissions, migrated.agents?.build?.permissions]) {
            expect(PermissionV2.evaluate("edit", "allowed/file.ts", rules ?? []).effect).toBe(override)
            expect(PermissionV2.evaluate("patch", "file.ts", rules ?? []).effect).toBe("ask")
            expect(PermissionV2.evaluate("apply_patch", "file.ts", rules ?? []).effect).toBe("ask")
          }
          // Top-level migration appends path overrides; agent normalization replaces the edit map.
          expect(PermissionV2.evaluate("edit", "other/file.ts", migrated.permissions ?? []).effect).toBe(action)
          expect(PermissionV2.evaluate("edit", "other/file.ts", migrated.agents?.build?.permissions ?? []).effect).toBe(
            "ask",
          )
        },
      ),
      { numRuns: 64, seed: 79 },
    )
  })
})
