import { describe, expect, test } from "bun:test"
import { Cause, Exit, Schema } from "effect"
import { FastCheck } from "effect/testing"
import { LLM } from "../src"
import * as Direct from "../src/llm"

const SafeInteger = Schema.decodeUnknownSync(Direct.SafeInteger)
const SafeNonNegativeInt = Schema.decodeUnknownSync(Direct.SafeNonNegativeInt)
const SafePositiveInt = Schema.decodeUnknownSync(Direct.SafePositiveInt)
const CanonicalDigestValue = Schema.decodeUnknownSync(Direct.CanonicalDigestValue)
const CanonicalCommitmentDomainV1 = Schema.decodeUnknownSync(Direct.CanonicalCommitmentDomainV1)

const RecoveryIDs = [
  Direct.RecoveryChainID,
  Direct.RecoveryAssistantID,
  Direct.RecoveryDecisionID,
  Direct.RecoveryOperationID,
  Direct.RecoveryAggregateID,
  Direct.RecoveryPolicyScopeKey,
  Direct.RecoverySealedRefID,
] as const

const CommitmentTypeNames = [
  "SemanticDigest",
  "PreparedDigest",
  "BindingDigest",
  "OperationPayloadDigest",
  "SupersessionBindingDigest",
  "EventChainDigest",
  "SourceFactsDigest",
  "RecoverySourceVersionDigest",
  "RecoveryControlTailDigest",
  "RecoveryPolicyDigest",
  "DispatchTargetDigest",
  "SealedMaterialCommitment",
  "PausedHandleCommitment",
  "RecoveryClosureDigest",
  "SourceAllowedEventSetDigest",
  "ControlAllowedEventSetDigest",
  "CredentialAuthorityVersionDigest",
  "ProviderAuthorizationProofDigest",
  "ControlPolicyDigest",
  "ToolPlanDigest",
  "ToolCallDigest",
  "ToolResultDigest",
  "ReasoningTextDigest",
  "ProviderPrefixDigest",
  "ProviderPrefixAncestryDigest",
] as const

const CanonicalCommitmentDomains = [
  "semantic-v1",
  "prepared-v1",
  "binding-v1",
  "operation-payload-v1",
  "supersession-binding-v1",
  "event-chain-v1",
  "source-facts-v1",
  "source-version-v1",
  "control-tail-v1",
  "recovery-policy-v1",
  "dispatch-target-v1",
  "sealed-material-v1",
  "paused-handle-v1",
  "recovery-closure-v1",
  "credential-authority-version-v1",
  "provider-authorization-proof-v1",
  "control-policy-v1",
  "tool-plan-v1",
  "tool-call-v1",
  "tool-result-v1",
  "reasoning-text-v1",
  "provider-prefix-v1",
  "provider-prefix-ancestry-v1",
  "source-allowed-event-set-v1",
  "control-allowed-event-set-v1",
] as const

const isValidRecoveryID = (value: string) =>
  value.length > 0 &&
  value === value.normalize("NFC") &&
  value === value.trim() &&
  !/\p{Cc}/u.test(value)

const lowercaseHexCharacter = FastCheck.constantFrom(..."0123456789abcdef")
const lowercaseSha256 = FastCheck.array(lowercaseHexCharacter, {
  minLength: 64,
  maxLength: 64,
}).map((characters) => characters.join(""))

describe("recovery contract foundation", () => {
  test("exports one canonical schema identity", () => {
    expect(LLM.SafeInteger).toBe(Direct.SafeInteger)
    expect(LLM.RecoveryChainID).toBe(Direct.RecoveryChainID)
    expect(LLM.CanonicalDigestValue).toBe(Direct.CanonicalDigestValue)
    expect(LLM.CanonicalCommitmentDomainV1).toBe(Direct.CanonicalCommitmentDomainV1)

    for (const name of CommitmentTypeNames) {
      expect(name in Direct).toBe(false)
    }

    const identifiers = [
      Direct.SafeInteger,
      Direct.SafeNonNegativeInt,
      Direct.SafePositiveInt,
      ...RecoveryIDs,
      Direct.CanonicalDigestValue,
      Direct.CanonicalCommitmentDomainV1,
    ].map((schema) => schema.ast.annotations?.identifier)
    expect(identifiers.every((identifier) => typeof identifier === "string")).toBe(true)
    expect(new Set(identifiers).size).toBe(identifiers.length)
  })

  test("validates safe integer refinements", () => {
    for (const value of [Number.MIN_SAFE_INTEGER, -1, 0, 1, Number.MAX_SAFE_INTEGER]) {
      expect(Number(SafeInteger(value))).toBe(value)
    }
    for (const value of [0, 1, Number.MAX_SAFE_INTEGER]) {
      expect(Number(SafeNonNegativeInt(value))).toBe(value)
    }
    for (const value of [1, Number.MAX_SAFE_INTEGER]) {
      expect(Number(SafePositiveInt(value))).toBe(value)
    }

    for (const value of [
      Number.MIN_SAFE_INTEGER - 1,
      Number.MAX_SAFE_INTEGER + 1,
      -0,
      1.5,
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(() => SafeInteger(value)).toThrow()
    }
    for (const value of [Number.MIN_SAFE_INTEGER, -1, -0]) {
      expect(() => SafeNonNegativeInt(value)).toThrow()
    }
    for (const value of [Number.MIN_SAFE_INTEGER, -1, -0, 0]) {
      expect(() => SafePositiveInt(value)).toThrow()
    }
  })

  test("round-trips every generated safe integer", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
        (value) => Schema.encodeSync(Direct.SafeInteger)(SafeInteger(value)) === value,
      ),
      { numRuns: 200 },
    )
  })

  test("validates recovery IDs without rewriting them", () => {
    for (const schema of RecoveryIDs) {
      const decode = Schema.decodeUnknownSync(schema)
      const encode = Schema.encodeSync(schema)
      for (const value of ["recovery-1", "chain alpha", "café", "δ-operation"]) {
        const decoded = decode(value)
        expect(String(decoded)).toBe(value)
        expect(String(encode(decoded))).toBe(value)
      }
      for (const value of ["", " leading", "trailing ", "é", "nul\0value", "line\nvalue", "delvalue"]) {
        expect(() => decode(value)).toThrow()
      }
    }
  })

  test("matches the recovery ID invariant for generated strings", () => {
    const decode = Schema.decodeUnknownSync(Direct.RecoveryChainID)
    FastCheck.assert(
      FastCheck.property(FastCheck.string(), (value) => {
        try {
          return decode(value) === value && isValidRecoveryID(value)
        } catch {
          return !isValidRecoveryID(value)
        }
      }),
      { numRuns: 300 },
    )
  })

  test("validates the exact unbranded canonical digest envelope", () => {
    const valid = {
      version: 1,
      algorithm: "sha256",
      encoding: "recovery-canonical-json",
      value: "a".repeat(64),
    } as const

    const decoded = CanonicalDigestValue(valid)
    expect(decoded).toEqual(valid)
    expect(Schema.encodeSync(Direct.CanonicalDigestValue)(decoded)).toEqual(valid)

    const foreignPrototype = Object.assign(Object.create({ realm: "foreign" }), valid)
    expect(CanonicalDigestValue(foreignPrototype).value).toBe(valid.value)

    for (const value of [
      { ...valid, version: 2 },
      { ...valid, algorithm: "sha512" },
      { ...valid, encoding: "json" },
      { ...valid, value: "a".repeat(63) },
      { ...valid, value: "A".repeat(64) },
      { ...valid, value: "g".repeat(64) },
      { ...valid, extra: true },
      { version: 1, algorithm: "sha256", encoding: "recovery-canonical-json" },
    ]) {
      expect(() => CanonicalDigestValue(value)).toThrow()
    }

    const symbolKey = { ...valid, [Symbol("extra")]: true }
    expect(() => CanonicalDigestValue(symbolKey)).toThrow()

    const accessor = { ...valid }
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get() {
        throw new Error("must not invoke accessor")
      },
    })
    expect(() => CanonicalDigestValue(accessor)).toThrow()

    const hostileProxy = new Proxy(valid, {
      ownKeys() {
        throw new Error("hostile reflection trap")
      },
    })
    expect(() => CanonicalDigestValue(hostileProxy)).toThrow()

    const revoked = Proxy.revocable(valid, {})
    revoked.revoke()
    const revokedExit = Schema.decodeUnknownExit(Direct.CanonicalDigestValue)(revoked.proxy)
    expect(Exit.isFailure(revokedExit)).toBe(true)
    if (Exit.isFailure(revokedExit)) expect(Cause.hasDies(revokedExit.cause)).toBe(false)
  })

  test("round-trips generated lowercase sha256 values", () => {
    FastCheck.assert(
      FastCheck.property(lowercaseSha256, (value) => {
        const input = {
          version: 1,
          algorithm: "sha256",
          encoding: "recovery-canonical-json",
          value,
        } as const
        return Schema.encodeSync(Direct.CanonicalDigestValue)(CanonicalDigestValue(input)).value === value
      }),
      { numRuns: 200 },
    )
  })

  test("keeps the canonical commitment domain set closed at 25", () => {
    expect(Direct.CanonicalCommitmentDomainV1.literals).toEqual(CanonicalCommitmentDomains)
    expect(CanonicalCommitmentDomains).toHaveLength(25)
    for (const domain of CanonicalCommitmentDomains) {
      expect(CanonicalCommitmentDomainV1(domain)).toBe(domain)
    }
    for (const domain of ["semantic", "semantic-v2", "unknown-v1", "control-allowed-event-set-v2"]) {
      expect(() => CanonicalCommitmentDomainV1(domain)).toThrow()
    }
  })
})
