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

export type ExactFieldSetSpecification<T> = Readonly<
  | { readonly kind: "literal"; readonly value: null | boolean | string | SafeNonNegativeInt }
  | { readonly kind: "string"; readonly validate: (value: string) => boolean }
  | { readonly kind: "safe-integer"; readonly minimum?: SafeInteger; readonly maximum?: SafeInteger }
  | {
      readonly kind: "array"
      readonly element: ExactFieldSetSpecification<unknown>
      readonly order: "semantic" | "registry-fixed"
    }
  | {
      readonly kind: "object"
      readonly required: readonly string[]
      readonly optional: readonly string[]
      readonly fields: Readonly<Record<string, ExactFieldSetSpecification<unknown>>>
    }
  | {
      readonly kind: "union"
      readonly discriminator: string
      readonly branches: Readonly<Record<string, ExactFieldSetSpecification<unknown>>>
    }
>

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

function fieldSetError(issue: FieldSetError["issue"], path: string, field?: string): FieldSetError {
  return {
    kind: "field-set",
    issue,
    path,
    ...(field === undefined ? {} : { field }),
  }
}

function fieldSetFailure(
  issue: FieldSetError["issue"],
  path: string,
  field?: string,
): ContractResult<never, FieldSetError> {
  return { ok: false, error: fieldSetError(issue, path, field) }
}

function ownDataProperty(object: object, key: PropertyKey) {
  const descriptor = Reflect.getOwnPropertyDescriptor(object, key)
  return descriptor !== undefined && "value" in descriptor ? descriptor : undefined
}

function exactDataProperties(object: object, required: readonly string[], optional: readonly string[] = []) {
  const allowed = new Set([...required, ...optional])
  const keys = Reflect.ownKeys(object)

  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) return false
    const descriptor = ownDataProperty(object, key)
    if (descriptor === undefined || !descriptor.enumerable) return false
  }
  for (const key of required) {
    if (ownDataProperty(object, key) === undefined) return false
  }
  for (const key of optional) {
    if (ownDataProperty(object, key) === undefined && Reflect.has(object, key)) return false
  }
  return true
}

function stringTuple(value: unknown) {
  if (!Array.isArray(value)) return undefined

  const lengthProperty = ownDataProperty(value, "length")
  const length = lengthProperty?.value
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return undefined

  const keys = Reflect.ownKeys(value)
  if (keys.length !== length + 1 || !keys.includes("length")) return undefined

  const result: string[] = []
  for (let index = 0; index < length; index++) {
    const descriptor = ownDataProperty(value, String(index))
    if (descriptor === undefined || !descriptor.enumerable || typeof descriptor.value !== "string") {
      return undefined
    }
    result.push(descriptor.value)
  }
  return result
}

function compareFieldNames(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

const IdentifierPathField = /^[A-Za-z_$][A-Za-z0-9_$]*$/

type FieldSetValidationPath =
  | Readonly<{ readonly kind: "root"; readonly value: string }>
  | Readonly<{ readonly kind: "child"; readonly parent: FieldSetValidationPath; readonly segment: string }>

function fieldPath(path: FieldSetValidationPath, field: string): FieldSetValidationPath {
  return {
    kind: "child",
    parent: path,
    segment: IdentifierPathField.test(field) ? `.${field}` : `[${JSON.stringify(field)}]`,
  }
}

function arrayPath(path: FieldSetValidationPath, index: number): FieldSetValidationPath {
  return { kind: "child", parent: path, segment: `[${index}]` }
}

function renderFieldSetPath(path: FieldSetValidationPath) {
  const segments: string[] = []
  let current = path
  while (current.kind === "child") {
    segments.push(current.segment)
    current = current.parent
  }
  segments.push(current.value)
  return segments.reverse().join("")
}

function symbolField(key: symbol) {
  return `[${String(key)}]`
}

const IntrinsicObjectConstructorSource = Function.prototype.toString.call(Object)

function isOrdinaryObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false

  const prototypes = new Set<object>()
  let prototype = Reflect.getPrototypeOf(value)
  while (prototype !== null) {
    if (prototypes.has(prototype)) return false
    prototypes.add(prototype)

    const parent = Reflect.getPrototypeOf(prototype)
    const constructor = Reflect.getOwnPropertyDescriptor(prototype, "constructor")
    if (constructor !== undefined) {
      if (parent !== null || !("value" in constructor) || typeof constructor.value !== "function") {
        return false
      }
      return (
        ownDataProperty(constructor.value, "name")?.value === "Object" &&
        ownDataProperty(constructor.value, "prototype")?.value === prototype &&
        Function.prototype.toString.call(constructor.value) === IntrinsicObjectConstructorSource
      )
    }
    prototype = parent
  }
  return true
}

function isSafeIntegerValue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)
}

function isLiteralSpecificationValue(value: unknown) {
  return (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (isSafeIntegerValue(value) && value >= 0)
  )
}

type CompiledExactFieldSetSpecification =
  | Readonly<{ readonly kind: "literal"; readonly value: null | boolean | string | number }>
  | Readonly<{ readonly kind: "string"; readonly validate: (value: string) => boolean }>
  | Readonly<{
      readonly kind: "safe-integer"
      readonly minimum?: number
      readonly maximum?: number
    }>
  | Readonly<{
      readonly kind: "array"
      readonly element: object
      readonly order: "semantic" | "registry-fixed"
    }>
  | Readonly<{
      readonly kind: "object"
      readonly required: readonly string[]
      readonly optional: readonly string[]
      readonly ordered: readonly string[]
      readonly expected: ReadonlySet<string>
      readonly fields: ReadonlyMap<string, object>
    }>
  | Readonly<{
      readonly kind: "union"
      readonly discriminator: string
      readonly branches: ReadonlyMap<string, object>
    }>

function compileExactFieldSetSpecification(
  specification: ExactFieldSetSpecification<unknown>,
  path: string,
): ContractResult<ReadonlyMap<object, CompiledExactFieldSetSpecification>, FieldSetError> {
  try {
    if (!isOrdinaryObject(specification)) return fieldSetFailure("wrong-set", path)

    const compiled = new Map<object, CompiledExactFieldSetSpecification>()
    const pending: object[] = [specification]
    while (pending.length > 0) {
      const current = pending.pop()
      if (current === undefined || compiled.has(current)) continue
      if (!isOrdinaryObject(current)) return fieldSetFailure("wrong-set", path)

      const kind = ownDataProperty(current, "kind")?.value
      if (kind === "literal") {
        if (!exactDataProperties(current, ["kind", "value"])) return fieldSetFailure("wrong-set", path)
        const expected = ownDataProperty(current, "value")?.value
        if (!isLiteralSpecificationValue(expected)) return fieldSetFailure("wrong-set", path)
        compiled.set(current, { kind, value: expected })
        continue
      }

      if (kind === "string") {
        if (!exactDataProperties(current, ["kind", "validate"])) return fieldSetFailure("wrong-set", path)
        const validate = ownDataProperty(current, "validate")?.value
        if (typeof validate !== "function") return fieldSetFailure("wrong-set", path)
        compiled.set(current, { kind, validate: validate as (value: string) => boolean })
        continue
      }

      if (kind === "safe-integer") {
        if (!exactDataProperties(current, ["kind"], ["minimum", "maximum"])) {
          return fieldSetFailure("wrong-set", path)
        }
        const minimumProperty = ownDataProperty(current, "minimum")
        const maximumProperty = ownDataProperty(current, "maximum")
        const minimum = minimumProperty?.value
        const maximum = maximumProperty?.value
        if (
          (minimumProperty !== undefined && !isSafeIntegerValue(minimum)) ||
          (maximumProperty !== undefined && !isSafeIntegerValue(maximum)) ||
          (typeof minimum === "number" && typeof maximum === "number" && minimum > maximum)
        ) {
          return fieldSetFailure("wrong-set", path)
        }
        compiled.set(current, {
          kind,
          ...(typeof minimum === "number" ? { minimum } : {}),
          ...(typeof maximum === "number" ? { maximum } : {}),
        })
        continue
      }

      if (kind === "array") {
        if (!exactDataProperties(current, ["kind", "element", "order"])) {
          return fieldSetFailure("wrong-set", path)
        }
        const element = ownDataProperty(current, "element")?.value
        const order = ownDataProperty(current, "order")?.value
        if (!isOrdinaryObject(element) || (order !== "semantic" && order !== "registry-fixed")) {
          return fieldSetFailure("wrong-set", path)
        }
        compiled.set(current, { kind, element, order })
        pending.push(element)
        continue
      }

      if (kind === "object") {
        if (!exactDataProperties(current, ["kind", "required", "optional", "fields"])) {
          return fieldSetFailure("wrong-set", path)
        }
        const required = stringTuple(ownDataProperty(current, "required")?.value)
        const optional = stringTuple(ownDataProperty(current, "optional")?.value)
        const fields = ownDataProperty(current, "fields")?.value
        if (required === undefined || optional === undefined || !isOrdinaryObject(fields)) {
          return fieldSetFailure("wrong-set", path)
        }

        const requiredSet = new Set(required)
        const optionalSet = new Set(optional)
        if (
          requiredSet.size !== required.length ||
          optionalSet.size !== optional.length ||
          required.some((field) => optionalSet.has(field))
        ) {
          return fieldSetFailure("wrong-set", path)
        }

        const expected = new Set([...required, ...optional])
        const fieldSpecifications = new Map<string, object>()
        const fieldKeys = Reflect.ownKeys(fields)
        if (fieldKeys.length !== expected.size) return fieldSetFailure("wrong-set", path)
        for (const key of fieldKeys) {
          if (typeof key !== "string" || !expected.has(key)) return fieldSetFailure("wrong-set", path)
          const descriptor = ownDataProperty(fields, key)
          if (descriptor === undefined || !descriptor.enumerable || !isOrdinaryObject(descriptor.value)) {
            return fieldSetFailure("wrong-set", path)
          }
          fieldSpecifications.set(key, descriptor.value)
          pending.push(descriptor.value)
        }
        compiled.set(current, {
          kind,
          required,
          optional,
          ordered: [...required, ...optional],
          expected,
          fields: fieldSpecifications,
        })
        continue
      }

      if (kind === "union") {
        if (!exactDataProperties(current, ["kind", "discriminator", "branches"])) {
          return fieldSetFailure("wrong-set", path)
        }
        const discriminator = ownDataProperty(current, "discriminator")?.value
        const branches = ownDataProperty(current, "branches")?.value
        if (typeof discriminator !== "string" || discriminator.length === 0 || !isOrdinaryObject(branches)) {
          return fieldSetFailure("wrong-set", path)
        }

        const branchSpecifications = new Map<string, object>()
        const branchKeys = Reflect.ownKeys(branches)
        if (branchKeys.length === 0) return fieldSetFailure("wrong-set", path)
        for (const key of branchKeys) {
          if (typeof key !== "string") return fieldSetFailure("wrong-set", path)
          const descriptor = ownDataProperty(branches, key)
          if (descriptor === undefined || !descriptor.enumerable || !isOrdinaryObject(descriptor.value)) {
            return fieldSetFailure("wrong-set", path)
          }
          branchSpecifications.set(key, descriptor.value)
          pending.push(descriptor.value)
        }
        compiled.set(current, { kind, discriminator, branches: branchSpecifications })
        continue
      }

      return fieldSetFailure("wrong-set", path)
    }

    return { ok: true, value: compiled }
  } catch {
    return fieldSetFailure("wrong-set", path)
  }
}

type FieldSetValidationFrame =
  | Readonly<{
      readonly kind: "validate"
      readonly value: unknown
      readonly specification: object
      readonly path: FieldSetValidationPath
    }>
  | Readonly<{
      readonly kind: "array-next"
      readonly value: unknown[]
      readonly element: object
      readonly index: number
      readonly length: number
      readonly path: FieldSetValidationPath
    }>
  | Readonly<{
      readonly kind: "object-next"
      readonly value: object
      readonly specification: Extract<CompiledExactFieldSetSpecification, { readonly kind: "object" }>
      readonly index: number
      readonly path: FieldSetValidationPath
    }>
  | Readonly<{ readonly kind: "leave-value"; readonly value: object }>
  | Readonly<{
      readonly kind: "leave-union"
      readonly value: object
      readonly specification: object
    }>
  | Readonly<{
      readonly kind: "complete"
      readonly value: object
      readonly specification: object
    }>

export function validateExactFieldSet<T>(
  value: unknown,
  specification: ExactFieldSetSpecification<T>,
  path?: string,
): ContractResult<void, FieldSetError> {
  // # Step P4: validate recursive exact field membership
  if (path !== undefined && typeof path !== "string") return fieldSetFailure("wrong-set", "$")

  const rootPath = path ?? "$"
  const compiledResult = compileExactFieldSetSpecification(
    specification as ExactFieldSetSpecification<unknown>,
    rootPath,
  )
  if (!compiledResult.ok) return compiledResult

  const specifications = compiledResult.value
  const rootSpecification = specification as object
  const activeValues = new Set<object>()
  const activeUnions = new Map<object, Set<object>>()
  const completed = new Map<object, Set<object>>()
  const frames: FieldSetValidationFrame[] = [
    {
      kind: "validate",
      value,
      specification: rootSpecification,
      path: { kind: "root", value: rootPath },
    },
  ]

  while (frames.length > 0) {
    const frame = frames.pop()
    if (frame === undefined) break

    if (frame.kind === "leave-value") {
      activeValues.delete(frame.value)
      continue
    }
    if (frame.kind === "leave-union") {
      const activeSpecifications = activeUnions.get(frame.value)
      activeSpecifications?.delete(frame.specification)
      if (activeSpecifications?.size === 0) activeUnions.delete(frame.value)
      continue
    }
    if (frame.kind === "complete") {
      let completedSpecifications = completed.get(frame.value)
      if (completedSpecifications === undefined) {
        completedSpecifications = new Set<object>()
        completed.set(frame.value, completedSpecifications)
      }
      completedSpecifications.add(frame.specification)
      continue
    }

    const currentPath = frame.path
    const renderedPath = () => renderFieldSetPath(currentPath)
    const fail = (issue: FieldSetError["issue"], field?: string): ContractResult<never, FieldSetError> =>
      fieldSetFailure(issue, renderedPath(), field)

    try {
      if (frame.kind === "array-next") {
        if (frame.index >= frame.length) continue
        const descriptor = Reflect.getOwnPropertyDescriptor(frame.value, String(frame.index))
        if (descriptor === undefined) return fail("missing", String(frame.index))
        if (!descriptor.enumerable) return fail("extra", String(frame.index))
        const childPath = arrayPath(currentPath, frame.index)
        if (!("value" in descriptor)) {
          return fieldSetFailure("wrong-set", renderFieldSetPath(childPath))
        }
        frames.push({ ...frame, index: frame.index + 1 })
        frames.push({
          kind: "validate",
          value: descriptor.value,
          specification: frame.element,
          path: childPath,
        })
        continue
      }

      if (frame.kind === "object-next") {
        if (frame.index >= frame.specification.ordered.length) continue
        const field = frame.specification.ordered[frame.index]
        const descriptor = Reflect.getOwnPropertyDescriptor(frame.value, field)
        frames.push({ ...frame, index: frame.index + 1 })
        if (descriptor === undefined) {
          if (frame.specification.required.includes(field)) return fail("missing", field)
          if (Reflect.has(frame.value, field)) return fail("extra", field)
          continue
        }
        if (!descriptor.enumerable) return fail("extra", field)
        const childPath = fieldPath(currentPath, field)
        if (!("value" in descriptor)) {
          return fieldSetFailure("wrong-set", renderFieldSetPath(childPath))
        }
        const fieldSpecification = frame.specification.fields.get(field)
        if (fieldSpecification === undefined) return fail("wrong-set")
        frames.push({
          kind: "validate",
          value: descriptor.value,
          specification: fieldSpecification,
          path: childPath,
        })
        continue
      }

      const currentValue = frame.value
      const currentSpecification = frame.specification
      const compiled = specifications.get(currentSpecification)
      if (compiled === undefined) return fail("wrong-set")
      if (
        typeof currentValue === "object" &&
        currentValue !== null &&
        completed.get(currentValue)?.has(currentSpecification)
      ) {
        continue
      }

      if (compiled.kind === "literal") {
        if (currentValue === null && compiled.value !== null) return fail("nullability")
        if (!Object.is(currentValue, compiled.value)) return fail("wrong-set")
        continue
      }

      if (compiled.kind === "string") {
        if (currentValue === null) return fail("nullability")
        if (typeof currentValue !== "string" || compiled.validate(currentValue) !== true) {
          return fail("wrong-set")
        }
        continue
      }

      if (compiled.kind === "safe-integer") {
        if (currentValue === null) return fail("nullability")
        if (
          !isSafeIntegerValue(currentValue) ||
          (compiled.minimum !== undefined && currentValue < compiled.minimum) ||
          (compiled.maximum !== undefined && currentValue > compiled.maximum)
        ) {
          return fail("wrong-set")
        }
        continue
      }

      if (compiled.kind === "array") {
        if (currentValue === null) return fail("nullability")
        if (!Array.isArray(currentValue) || activeValues.has(currentValue)) return fail("wrong-set")

        const length = ownDataProperty(currentValue, "length")?.value
        if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
          return fail("wrong-set")
        }

        let extraField: string | undefined
        for (const key of Reflect.ownKeys(currentValue)) {
          if (key === "length") continue
          const field = typeof key === "symbol" ? symbolField(key) : key
          const descriptor = Reflect.getOwnPropertyDescriptor(currentValue, key)
          const index = typeof key === "string" ? Number(key) : Number.NaN
          if (
            descriptor === undefined ||
            !descriptor.enumerable ||
            typeof key === "symbol" ||
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= length ||
            String(index) !== key
          ) {
            if (extraField === undefined || compareFieldNames(field, extraField) < 0) extraField = field
          }
        }
        if (extraField !== undefined) return fail("extra", extraField)
        for (let index = 0; index < length; index++) {
          if (Reflect.getOwnPropertyDescriptor(currentValue, String(index)) === undefined) {
            return fail("missing", String(index))
          }
        }

        activeValues.add(currentValue)
        frames.push({ kind: "leave-value", value: currentValue })
        frames.push({ kind: "complete", value: currentValue, specification: currentSpecification })
        frames.push({
          kind: "array-next",
          value: currentValue,
          element: compiled.element,
          index: 0,
          length,
          path: currentPath,
        })
        continue
      }

      if (compiled.kind === "object") {
        if (currentValue === null) return fail("nullability")
        if (!isOrdinaryObject(currentValue) || activeValues.has(currentValue)) return fail("wrong-set")

        let extraField: string | undefined
        for (const key of Reflect.ownKeys(currentValue)) {
          const field = typeof key === "symbol" ? symbolField(key) : key
          const descriptor = Reflect.getOwnPropertyDescriptor(currentValue, key)
          if (
            descriptor === undefined ||
            !descriptor.enumerable ||
            typeof key === "symbol" ||
            !compiled.expected.has(key)
          ) {
            if (extraField === undefined || compareFieldNames(field, extraField) < 0) extraField = field
          }
        }
        if (extraField !== undefined) return fail("extra", extraField)
        for (const field of compiled.required) {
          if (Reflect.getOwnPropertyDescriptor(currentValue, field) === undefined) {
            return fail("missing", field)
          }
        }
        for (const field of compiled.optional) {
          if (Reflect.getOwnPropertyDescriptor(currentValue, field) === undefined && Reflect.has(currentValue, field)) {
            return fail("extra", field)
          }
        }

        activeValues.add(currentValue)
        frames.push({ kind: "leave-value", value: currentValue })
        frames.push({ kind: "complete", value: currentValue, specification: currentSpecification })
        frames.push({
          kind: "object-next",
          value: currentValue,
          specification: compiled,
          index: 0,
          path: currentPath,
        })
        continue
      }

      if (compiled.kind === "union") {
        if (currentValue === null) return fail("nullability")
        if (!isOrdinaryObject(currentValue)) return fail("wrong-set")

        const discriminatorProperty = Reflect.getOwnPropertyDescriptor(currentValue, compiled.discriminator)
        if (discriminatorProperty === undefined) return fail("missing", compiled.discriminator)
        const discriminatorPath = fieldPath(currentPath, compiled.discriminator)
        if (!discriminatorProperty.enumerable) return fail("extra", compiled.discriminator)
        if (!("value" in discriminatorProperty) || typeof discriminatorProperty.value !== "string") {
          return fieldSetFailure("wrong-set", renderFieldSetPath(discriminatorPath))
        }

        const branch = compiled.branches.get(discriminatorProperty.value)
        if (branch === undefined) {
          return fieldSetFailure("wrong-set", renderFieldSetPath(discriminatorPath))
        }

        let activeSpecifications = activeUnions.get(currentValue)
        if (activeSpecifications?.has(currentSpecification)) return fail("wrong-set")
        if (activeSpecifications === undefined) {
          activeSpecifications = new Set<object>()
          activeUnions.set(currentValue, activeSpecifications)
        }
        activeSpecifications.add(currentSpecification)
        frames.push({
          kind: "leave-union",
          value: currentValue,
          specification: currentSpecification,
        })
        frames.push({ kind: "complete", value: currentValue, specification: currentSpecification })
        frames.push({
          kind: "validate",
          value: currentValue,
          specification: branch,
          path: currentPath,
        })
        continue
      }
    } catch {
      return fail("wrong-set")
    }
  }

  return { ok: true, value: undefined }
}

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
