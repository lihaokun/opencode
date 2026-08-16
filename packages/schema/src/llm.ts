export * as LLM from "./llm"

import { Schema } from "effect"
import { optional } from "./schema"

export const ProviderMetadata = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)).annotate({
  identifier: "LLM.ProviderMetadata",
})
export type ProviderMetadata = Schema.Schema.Type<typeof ProviderMetadata>

export interface ToolTextContent extends Schema.Schema.Type<typeof ToolTextContent> {}
export const ToolTextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
}).annotate({ identifier: "Tool.TextContent" })

export interface ToolFileContent extends Schema.Schema.Type<typeof ToolFileContent> {}
export const ToolFileContent = Schema.Struct({
  type: Schema.Literal("file"),
  uri: Schema.String,
  mime: Schema.String,
  name: optional(Schema.String),
}).annotate({ identifier: "Tool.FileContent" })

export const ToolContent = Schema.Union([ToolTextContent, ToolFileContent])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "LLM.ToolContent" })
export type ToolContent = Schema.Schema.Type<typeof ToolContent>

declare const recoveryBrand: unique symbol
export type Brand<Name extends string> = {
  readonly [recoveryBrand]: { readonly [Key in Name]: Key }
}

export type SafeInteger = number & Brand<"SafeInteger">
export const SafeInteger = Schema.declare<SafeInteger>(
  (value): value is SafeInteger =>
    typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0),
  { identifier: "Recovery.SafeInteger" },
)

export type SafeNonNegativeInt = SafeInteger & Brand<"SafeNonNegativeInt">
export const SafeNonNegativeInt = Schema.declare<SafeNonNegativeInt>(
  (value): value is SafeNonNegativeInt =>
    typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0,
  { identifier: "Recovery.SafeNonNegativeInt" },
)

export type SafePositiveInt = SafeInteger & Brand<"SafePositiveInt">
export const SafePositiveInt = Schema.declare<SafePositiveInt>(
  (value): value is SafePositiveInt =>
    typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0) && value > 0,
  { identifier: "Recovery.SafePositiveInt" },
)

const RecoveryIDControlCharacter = /\p{Cc}/u

function recoveryID<Name extends string>(name: Name) {
  return Schema.declare<string & Brand<Name>>(
    (value): value is string & Brand<Name> =>
      typeof value === "string" &&
      value.length > 0 &&
      value === value.normalize("NFC") &&
      value === value.trim() &&
      !RecoveryIDControlCharacter.test(value),
    { identifier: `Recovery.${name}` },
  )
}

export const RecoveryChainID = recoveryID("RecoveryChainID")
export type RecoveryChainID = Schema.Schema.Type<typeof RecoveryChainID>

export const RecoveryAssistantID = recoveryID("RecoveryAssistantID")
export type RecoveryAssistantID = Schema.Schema.Type<typeof RecoveryAssistantID>

export const RecoveryDecisionID = recoveryID("RecoveryDecisionID")
export type RecoveryDecisionID = Schema.Schema.Type<typeof RecoveryDecisionID>

export const RecoveryOperationID = recoveryID("RecoveryOperationID")
export type RecoveryOperationID = Schema.Schema.Type<typeof RecoveryOperationID>

export const RecoveryAggregateID = recoveryID("RecoveryAggregateID")
export type RecoveryAggregateID = Schema.Schema.Type<typeof RecoveryAggregateID>

export const RecoveryPolicyScopeKey = recoveryID("RecoveryPolicyScopeKey")
export type RecoveryPolicyScopeKey = Schema.Schema.Type<typeof RecoveryPolicyScopeKey>

export const RecoverySealedRefID = recoveryID("RecoverySealedRefID")
export type RecoverySealedRefID = Schema.Schema.Type<typeof RecoverySealedRefID>

export type CanonicalDigestValue = Readonly<{
  version: 1
  algorithm: "sha256"
  encoding: "recovery-canonical-json"
  value: string
}>

const CanonicalDigestValueKeys = ["version", "algorithm", "encoding", "value"] as const

export const CanonicalDigestValue = Schema.declare<CanonicalDigestValue>(
  (input): input is CanonicalDigestValue => {
    if (typeof input !== "object" || input === null) return false

    try {
      if (Array.isArray(input)) return false

      const keys = Reflect.ownKeys(input)
      if (
        keys.length !== CanonicalDigestValueKeys.length ||
        !CanonicalDigestValueKeys.every((key) => keys.includes(key))
      ) {
        return false
      }

      const descriptors = Object.getOwnPropertyDescriptors(input)
      const version = descriptors.version
      const algorithm = descriptors.algorithm
      const encoding = descriptors.encoding
      const value = descriptors.value
      if (
        version === undefined ||
        algorithm === undefined ||
        encoding === undefined ||
        value === undefined ||
        !("value" in version) ||
        !("value" in algorithm) ||
        !("value" in encoding) ||
        !("value" in value) ||
        !version.enumerable ||
        !algorithm.enumerable ||
        !encoding.enumerable ||
        !value.enumerable
      ) {
        return false
      }

      return (
        version.value === 1 &&
        algorithm.value === "sha256" &&
        encoding.value === "recovery-canonical-json" &&
        typeof value.value === "string" &&
        /^[0-9a-f]{64}$/.test(value.value)
      )
    } catch {
      return false
    }
  },
  { identifier: "Recovery.CanonicalDigestValue" },
)

export const CanonicalCommitmentDomainV1 = Schema.Literals([
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
]).annotate({ identifier: "Recovery.CanonicalCommitmentDomainV1" })
export type CanonicalCommitmentDomainV1 = Schema.Schema.Type<typeof CanonicalCommitmentDomainV1>

export type Commitment<Name extends string> = CanonicalDigestValue & Brand<Name>
export type SemanticDigest = Commitment<"SemanticDigest">
export type PreparedDigest = Commitment<"PreparedDigest">
export type BindingDigest = Commitment<"BindingDigest">
export type OperationPayloadDigest = Commitment<"OperationPayloadDigest">
export type SupersessionBindingDigest = Commitment<"SupersessionBindingDigest">
export type EventChainDigest = Commitment<"EventChainDigest">
export type SourceFactsDigest = Commitment<"SourceFactsDigest">
export type RecoverySourceVersionDigest = Commitment<"RecoverySourceVersionDigest">
export type RecoveryControlTailDigest = Commitment<"RecoveryControlTailDigest">
export type RecoveryPolicyDigest = Commitment<"RecoveryPolicyDigest">
export type DispatchTargetDigest = Commitment<"DispatchTargetDigest">
export type SealedMaterialCommitment = Commitment<"SealedMaterialCommitment">
export type PausedHandleCommitment = Commitment<"PausedHandleCommitment">
export type RecoveryClosureDigest = Commitment<"RecoveryClosureDigest">
export type SourceAllowedEventSetDigest = Commitment<"SourceAllowedEventSetDigest">
export type ControlAllowedEventSetDigest = Commitment<"ControlAllowedEventSetDigest">
export type CredentialAuthorityVersionDigest = Commitment<"CredentialAuthorityVersionDigest">
export type ProviderAuthorizationProofDigest = Commitment<"ProviderAuthorizationProofDigest">
export type ControlPolicyDigest = Commitment<"ControlPolicyDigest">
export type ToolPlanDigest = Commitment<"ToolPlanDigest">
export type ToolCallDigest = Commitment<"ToolCallDigest">
export type ToolResultDigest = Commitment<"ToolResultDigest">
export type ReasoningTextDigest = Commitment<"ReasoningTextDigest">
export type ProviderPrefixDigest = Commitment<"ProviderPrefixDigest">
export type ProviderPrefixAncestryDigest = Commitment<"ProviderPrefixAncestryDigest">

export type ConfigCodecError = Readonly<{
  kind: "config-codec"
  issue: "wrong-type" | "unsafe-integer" | "negative" | "zero-not-allowed" | "unknown-field"
  path: string
}>
export type EventDefinitionError = Readonly<{
  kind: "event-definition"
  issue:
    | "invalid-type"
    | "invalid-publication"
    | "invalid-durable-version"
    | "aggregate-field-missing"
    | "schema-construction-failed"
    | "duplicate-type"
    | "duplicate-versioned-type"
    | "public-internal-leak"
  path: string
}>
export type RecoveryDecodeError = Readonly<{
  kind: "recovery-decode"
  issue:
    | "malformed"
    | "unknown-event-type"
    | "unknown-event-version"
    | "unknown-field-set-version"
    | "discriminator-mismatch"
    | "not-recovery-event"
    | "aggregate-mismatch"
    | "sequence-mismatch"
    | "chain-broken"
    | "owner-mismatch"
    | "inconsistent-evidence"
  path: string
}>
export type FieldSetError = Readonly<{
  kind: "field-set"
  issue: "missing" | "extra" | "nullability" | "wrong-set"
  path: string
  field?: string
}>
export type NormalizationError = Readonly<{
  kind: "normalization"
  issue:
    | "target"
    | "authority"
    | "storage"
    | "policy"
    | "provenance"
    | "capability"
    | "sealed-reference"
    | "receipt"
    | "identity"
    | "binding"
  path: string
}>
export type CanonicalizationError = Readonly<{
  kind: "canonicalization"
  issue:
    | "unsupported"
    | "cycle"
    | "unsafe-number"
    | "negative-zero"
    | "lone-surrogate"
    | "raw-secret"
    | "schema-member"
    | "crypto-failed"
  path: string
}>
export type DigestMismatchError = Readonly<{
  kind: "digest-mismatch"
  issue: "metadata" | "domain" | "brand" | "value"
  domain: CanonicalCommitmentDomainV1
}>
export type PublicProjectionViolation = Readonly<{
  kind: "public-projection"
  issue: "malformed" | "unsupported-field" | "forbidden-key" | "forbidden-shape" | "unsafe-display-id"
  path: string
}>

export type RecoveryContractError =
  | ConfigCodecError
  | EventDefinitionError
  | RecoveryDecodeError
  | FieldSetError
  | NormalizationError
  | CanonicalizationError
  | DigestMismatchError
  | PublicProjectionViolation

export type ContractResult<A, E extends RecoveryContractError = RecoveryContractError> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: E }

export type ErrorKinds<K extends RecoveryContractError["kind"]> = Extract<
  RecoveryContractError,
  { readonly kind: K }
>
export type CodecError = ConfigCodecError | FieldSetError
export type DecodeError = RecoveryDecodeError | FieldSetError | DigestMismatchError | CanonicalizationError
export type NormalizationContractError = FieldSetError | NormalizationError | DigestMismatchError | CanonicalizationError
export type CanonicalContractError = FieldSetError | CanonicalizationError
export type DigestContractError = FieldSetError | CanonicalizationError | DigestMismatchError
export type ReceiptValidationError =
  | RecoveryDecodeError
  | FieldSetError
  | NormalizationError
  | DigestMismatchError
  | CanonicalizationError
export type SealedRefStructuralValidationError = RecoveryDecodeError | FieldSetError | NormalizationError
