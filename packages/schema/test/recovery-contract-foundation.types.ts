import { Schema } from "effect"
import { LLM } from "../src"
import type * as Direct from "../src/llm"

type Assert<T extends true> = T
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assignable<A, B> = [A] extends [B] ? true : false

type RootSafeInteger = Schema.Schema.Type<typeof LLM.SafeInteger>
type RootRecoveryChainID = Schema.Schema.Type<typeof LLM.RecoveryChainID>
type RootCanonicalDigestValue = Schema.Schema.Type<typeof LLM.CanonicalDigestValue>
type RootCanonicalCommitmentDomainV1 = Schema.Schema.Type<typeof LLM.CanonicalCommitmentDomainV1>

type _RootSafeIntegerMatches = Assert<Equal<RootSafeInteger, Direct.SafeInteger>>
type _RootRecoveryChainIDMatches = Assert<Equal<RootRecoveryChainID, Direct.RecoveryChainID>>
type _RootCanonicalDigestValueMatches = Assert<Equal<RootCanonicalDigestValue, Direct.CanonicalDigestValue>>
type _RootCanonicalDomainMatches = Assert<
  Equal<RootCanonicalCommitmentDomainV1, Direct.CanonicalCommitmentDomainV1>
>

function unwrap(result: Direct.ContractResult<number, Direct.ConfigCodecError>) {
  if (result.ok) {
    const value: number = result.value
    // @ts-expect-error success has no error member
    result.error
    return value
  }
  const error: Direct.ConfigCodecError = result.error
  // @ts-expect-error failure has no value member
  result.value
  return error.path.length
}

const configError: Direct.ConfigCodecError = {
  kind: "config-codec",
  issue: "unsafe-integer",
  path: "experimental.session_recovery.max_incomplete_recoveries",
}
void configError

// @ts-expect-error config issue set is closed
const invalidConfigError: Direct.ConfigCodecError = { kind: "config-codec", issue: "invalid", path: "x" }
void invalidConfigError

const fieldSetError: Direct.FieldSetError = {
  kind: "field-set",
  issue: "extra",
  path: "payload",
  field: "secret",
}
void fieldSetError

const invalidNormalizationError: Direct.NormalizationError = {
  kind: "normalization",
  issue: "target",
  path: "target",
  // @ts-expect-error only FieldSetError carries the optional field member
  field: "providerID",
}
void invalidNormalizationError

const digestMismatchError: Direct.DigestMismatchError = {
  kind: "digest-mismatch",
  issue: "domain",
  domain: "semantic-v1",
}
void digestMismatchError

const invalidDigestMismatchError: Direct.DigestMismatchError = {
  kind: "digest-mismatch",
  issue: "domain",
  // @ts-expect-error DigestMismatchError requires domain and has no path
  path: "digest",
}
void invalidDigestMismatchError

type ErrorMap = {
  "config-codec": Direct.ConfigCodecError
  "event-definition": Direct.EventDefinitionError
  "recovery-decode": Direct.RecoveryDecodeError
  "field-set": Direct.FieldSetError
  normalization: Direct.NormalizationError
  canonicalization: Direct.CanonicalizationError
  "digest-mismatch": Direct.DigestMismatchError
  "public-projection": Direct.PublicProjectionViolation
}

type ExpectedErrorIssues = {
  "config-codec": "wrong-type" | "unsafe-integer" | "negative" | "zero-not-allowed" | "unknown-field"
  "event-definition":
    | "invalid-type"
    | "invalid-publication"
    | "invalid-durable-version"
    | "aggregate-field-missing"
    | "schema-construction-failed"
    | "duplicate-type"
    | "duplicate-versioned-type"
    | "public-internal-leak"
  "recovery-decode":
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
  "field-set": "missing" | "extra" | "nullability" | "wrong-set"
  normalization:
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
  canonicalization:
    | "unsupported"
    | "cycle"
    | "unsafe-number"
    | "negative-zero"
    | "lone-surrogate"
    | "raw-secret"
    | "schema-member"
    | "crypto-failed"
  "digest-mismatch": "metadata" | "domain" | "brand" | "value"
  "public-projection": "malformed" | "unsupported-field" | "forbidden-key" | "forbidden-shape" | "unsafe-display-id"
}

type ExpectedErrorFields = {
  "config-codec": "kind" | "issue" | "path"
  "event-definition": "kind" | "issue" | "path"
  "recovery-decode": "kind" | "issue" | "path"
  "field-set": "kind" | "issue" | "path" | "field"
  normalization: "kind" | "issue" | "path"
  canonicalization: "kind" | "issue" | "path"
  "digest-mismatch": "kind" | "issue" | "domain"
  "public-projection": "kind" | "issue" | "path"
}

type ErrorIssuesAreExact = {
  [K in keyof ErrorMap]: Equal<ErrorMap[K]["issue"], ExpectedErrorIssues[K]>
}[keyof ErrorMap]
type ErrorFieldsAreExact = {
  [K in keyof ErrorMap]: Equal<keyof ErrorMap[K], ExpectedErrorFields[K]>
}[keyof ErrorMap]
type ErrorKindsAreExact = Equal<Direct.RecoveryContractError["kind"], keyof ErrorMap>
type _ErrorIssuesAreExact = Assert<Equal<ErrorIssuesAreExact, true>>
type _ErrorFieldsAreExact = Assert<Equal<ErrorFieldsAreExact, true>>
type _ErrorKindsAreExact = Assert<ErrorKindsAreExact>

declare const safeInteger: Direct.SafeInteger
declare const safeNonNegativeInt: Direct.SafeNonNegativeInt
declare const safePositiveInt: Direct.SafePositiveInt

const nonNegativeAsSafe: Direct.SafeInteger = safeNonNegativeInt
const positiveAsSafe: Direct.SafeInteger = safePositiveInt
void nonNegativeAsSafe
void positiveAsSafe

// @ts-expect-error raw number is not branded SafeInteger
const rawSafeInteger: Direct.SafeInteger = 1
void rawSafeInteger

// @ts-expect-error SafeInteger does not prove non-negative
const safeAsNonNegative: Direct.SafeNonNegativeInt = safeInteger
void safeAsNonNegative

// @ts-expect-error SafeInteger does not prove positive
const safeAsPositive: Direct.SafePositiveInt = safeInteger
void safeAsPositive

// @ts-expect-error the two refinements are independently branded
const positiveAsNonNegative: Direct.SafeNonNegativeInt = safePositiveInt
void positiveAsNonNegative

// @ts-expect-error the two refinements are independently branded
const nonNegativeAsPositive: Direct.SafePositiveInt = safeNonNegativeInt
void nonNegativeAsPositive

declare const chainID: Direct.RecoveryChainID
declare const assistantID: Direct.RecoveryAssistantID
declare const decisionID: Direct.RecoveryDecisionID
declare const operationID: Direct.RecoveryOperationID
declare const aggregateID: Direct.RecoveryAggregateID
declare const policyScopeKey: Direct.RecoveryPolicyScopeKey
declare const sealedRefID: Direct.RecoverySealedRefID

const idsAsStrings: readonly string[] = [
  chainID,
  assistantID,
  decisionID,
  operationID,
  aggregateID,
  policyScopeKey,
  sealedRefID,
]
void idsAsStrings

// @ts-expect-error raw string is not a RecoveryChainID
const rawChainID: Direct.RecoveryChainID = "chain"
void rawChainID

// @ts-expect-error recovery authority ID brands are pairwise distinct
const assistantAsChain: Direct.RecoveryChainID = assistantID
void assistantAsChain

type RecoveryIDMap = {
  RecoveryChainID: Direct.RecoveryChainID
  RecoveryAssistantID: Direct.RecoveryAssistantID
  RecoveryDecisionID: Direct.RecoveryDecisionID
  RecoveryOperationID: Direct.RecoveryOperationID
  RecoveryAggregateID: Direct.RecoveryAggregateID
  RecoveryPolicyScopeKey: Direct.RecoveryPolicyScopeKey
  RecoverySealedRefID: Direct.RecoverySealedRefID
}

type CrossRecoveryIDAssignments = {
  [K in keyof RecoveryIDMap]: {
    [Other in Exclude<keyof RecoveryIDMap, K>]: Assignable<RecoveryIDMap[K], RecoveryIDMap[Other]>
  }[Exclude<keyof RecoveryIDMap, K>]
}[keyof RecoveryIDMap]
type _RecoveryIDsArePairwiseDistinct = Assert<Equal<CrossRecoveryIDAssignments, false>>

type RawStringIDAssignments = {
  [K in keyof RecoveryIDMap]: Assignable<string, RecoveryIDMap[K]>
}[keyof RecoveryIDMap]
type _RawStringCannotReplaceRecoveryID = Assert<Equal<RawStringIDAssignments, false>>

type CommitmentMap = {
  SemanticDigest: Direct.SemanticDigest
  PreparedDigest: Direct.PreparedDigest
  BindingDigest: Direct.BindingDigest
  OperationPayloadDigest: Direct.OperationPayloadDigest
  SupersessionBindingDigest: Direct.SupersessionBindingDigest
  EventChainDigest: Direct.EventChainDigest
  SourceFactsDigest: Direct.SourceFactsDigest
  RecoverySourceVersionDigest: Direct.RecoverySourceVersionDigest
  RecoveryControlTailDigest: Direct.RecoveryControlTailDigest
  RecoveryPolicyDigest: Direct.RecoveryPolicyDigest
  DispatchTargetDigest: Direct.DispatchTargetDigest
  SealedMaterialCommitment: Direct.SealedMaterialCommitment
  PausedHandleCommitment: Direct.PausedHandleCommitment
  RecoveryClosureDigest: Direct.RecoveryClosureDigest
  SourceAllowedEventSetDigest: Direct.SourceAllowedEventSetDigest
  ControlAllowedEventSetDigest: Direct.ControlAllowedEventSetDigest
  CredentialAuthorityVersionDigest: Direct.CredentialAuthorityVersionDigest
  ProviderAuthorizationProofDigest: Direct.ProviderAuthorizationProofDigest
  ControlPolicyDigest: Direct.ControlPolicyDigest
  ToolPlanDigest: Direct.ToolPlanDigest
  ToolCallDigest: Direct.ToolCallDigest
  ToolResultDigest: Direct.ToolResultDigest
  ReasoningTextDigest: Direct.ReasoningTextDigest
  ProviderPrefixDigest: Direct.ProviderPrefixDigest
  ProviderPrefixAncestryDigest: Direct.ProviderPrefixAncestryDigest
}

type AllCommitmentsExtendCanonical = {
  [K in keyof CommitmentMap]: Assignable<CommitmentMap[K], Direct.CanonicalDigestValue>
}[keyof CommitmentMap]
type _AllCommitmentsExtendCanonical = Assert<Equal<AllCommitmentsExtendCanonical, true>>

type CrossCommitmentAssignments = {
  [K in keyof CommitmentMap]: {
    [Other in Exclude<keyof CommitmentMap, K>]: Assignable<CommitmentMap[K], CommitmentMap[Other]>
  }[Exclude<keyof CommitmentMap, K>]
}[keyof CommitmentMap]
type _CommitmentsArePairwiseDistinct = Assert<Equal<CrossCommitmentAssignments, false>>

type RawCanonicalAssignments = {
  [K in keyof CommitmentMap]: Assignable<Direct.CanonicalDigestValue, CommitmentMap[K]>
}[keyof CommitmentMap]
type _RawCanonicalCannotReplaceCommitment = Assert<Equal<RawCanonicalAssignments, false>>

declare const canonicalDigest: Direct.CanonicalDigestValue
declare const semanticDigest: Direct.SemanticDigest
declare const preparedDigest: Direct.PreparedDigest

const semanticAsCanonical: Direct.CanonicalDigestValue = semanticDigest
void semanticAsCanonical

// @ts-expect-error unbranded digest cannot replace a semantic digest
const canonicalAsSemantic: Direct.SemanticDigest = canonicalDigest
void canonicalAsSemantic

// @ts-expect-error commitment brands cannot cross domains
const preparedAsSemantic: Direct.SemanticDigest = preparedDigest
void preparedAsSemantic

void unwrap
