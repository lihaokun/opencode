import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { IncompleteStreamRecovery as RootRecovery } from "../src"
import { SessionEvent } from "../src/session-event"
import { SessionMessage } from "../src/session-message"
import { IncompleteStreamRecovery } from "../src/session-recovery"
import { SessionV1 } from "../src/v1/session"

const recovery = IncompleteStreamRecovery.Info.make({
  classification: "incomplete-stream",
  action: "safe-retry",
  reason: "no-tool-evidence",
  tools: [],
  retry: { attempt: 0, limit: 2 },
})

const currentAssistant = {
  id: "msg_current",
  type: "assistant",
  agent: "build",
  model: { id: "model", providerID: "provider" },
  content: [],
  time: { created: 0 },
} as const

const legacyAssistant = {
  id: "msg_legacy",
  sessionID: "ses_legacy",
  role: "assistant",
  time: { created: 0 },
  parentID: "msg_parent",
  modelID: "model",
  providerID: "provider",
  mode: "build",
  agent: "build",
  path: { cwd: "/project", root: "/project" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
} as const

describe("incomplete stream recovery schema", () => {
  test("exports one canonical root namespace and stable unique identifiers", () => {
    expect(RootRecovery.Info).toBe(IncompleteStreamRecovery.Info)
    const identifiers = [
      IncompleteStreamRecovery.Classification,
      IncompleteStreamRecovery.Action,
      IncompleteStreamRecovery.Reason,
      IncompleteStreamRecovery.ToolState,
      IncompleteStreamRecovery.ToolEvidence,
      IncompleteStreamRecovery.Retry,
      IncompleteStreamRecovery.Info,
    ].map((schema) => schema.ast.annotations?.identifier)

    expect(identifiers).toEqual([
      "Session.IncompleteStreamRecovery.Classification",
      "Session.IncompleteStreamRecovery.Action",
      "Session.IncompleteStreamRecovery.Reason",
      "Session.IncompleteStreamRecovery.ToolState",
      "Session.IncompleteStreamRecovery.ToolEvidence",
      "Session.IncompleteStreamRecovery.Retry",
      "Session.IncompleteStreamRecovery",
    ])
    expect(new Set(identifiers).size).toBe(identifiers.length)
  })

  test("round-trips recovery and rejects invalid structural fields", () => {
    const decode = Schema.decodeUnknownSync(IncompleteStreamRecovery.Info)
    expect(Schema.encodeSync(IncompleteStreamRecovery.Info)(decode(recovery))).toEqual(recovery)
    expect(() => decode({ ...recovery, action: "retry" })).toThrow()
    expect(() => decode({ ...recovery, retry: { attempt: -1, limit: 2 } })).toThrow()
    expect(() =>
      decode({
        ...recovery,
        action: "continue-after-settled-tools",
        reason: "settled-tools",
        tools: [
          {
            id: "",
            name: "bash",
            state: "completed",
            completeCall: true,
            inputPersisted: true,
            providerExecuted: true,
            terminalResultPersisted: true,
            interrupted: false,
          },
        ],
      }),
    ).toThrow()
  })

  test("emits the documented JSON Schema fields and enum values", () => {
    const document = Schema.toJsonSchemaDocument(IncompleteStreamRecovery.Info)
    const serialized = JSON.stringify(document)
    expect(serialized).toContain('"Session.IncompleteStreamRecovery"')
    expect(serialized).toContain('"safe-retry"')
    expect(serialized).toContain('"continue-after-settled-tools"')
    expect(serialized).toContain('"manual-stop"')
    expect(serialized).toContain('"terminalResultPersisted"')
  })

  test("keeps recovery optional on current and legacy assistant messages", () => {
    const decodeCurrent = Schema.decodeUnknownSync(SessionMessage.Assistant)
    const encodeCurrent = Schema.encodeSync(SessionMessage.Assistant)
    const currentWithout = decodeCurrent(currentAssistant)
    expect(currentWithout.recovery).toBeUndefined()
    expect(encodeCurrent(currentWithout)).not.toHaveProperty("recovery")
    expect(decodeCurrent({ ...currentAssistant, recovery }).recovery).toEqual(recovery)

    const decodeLegacy = Schema.decodeUnknownSync(SessionV1.Assistant)
    const encodeLegacy = Schema.encodeSync(SessionV1.Assistant)
    const legacyWithout = decodeLegacy(legacyAssistant)
    expect(legacyWithout.recovery).toBeUndefined()
    expect(encodeLegacy(legacyWithout)).not.toHaveProperty("recovery")
    expect(decodeLegacy({ ...legacyAssistant, recovery }).recovery).toEqual(recovery)
  })

  test("keeps recovery optional on current failed step events", () => {
    const decode = Schema.decodeUnknownSync(SessionEvent.Step.Failed.data)
    const base = {
      timestamp: 0,
      sessionID: "ses_recovery",
      assistantMessageID: "msg_recovery",
      error: { type: "unknown", message: "provider stream ended without a terminal finish" },
    }
    expect(decode(base).recovery).toBeUndefined()
    expect(decode({ ...base, recovery }).recovery).toEqual(recovery)
  })
})
