import { Schema } from "effect"
import { LLM } from "../src"
import type * as Direct from "../src/llm"

type Assert<T extends true> = T
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

const minimum = Schema.decodeUnknownSync(LLM.SafeInteger)(0)
const literal = Schema.decodeUnknownSync(LLM.SafeNonNegativeInt)(1)

const specification = {
  kind: "object",
  required: ["kind", "count"],
  optional: ["note"],
  fields: {
    kind: { kind: "literal", value: "entry" },
    count: { kind: "safe-integer", minimum },
    note: { kind: "string", validate: (value: string) => value.length > 0 },
  },
} as const satisfies Direct.ExactFieldSetSpecification<{
  readonly kind: "entry"
  readonly count: Direct.SafeInteger
  readonly note?: string
}>

const result = LLM.validateExactFieldSet({ kind: "entry", count: 1 }, specification)
type _ExactResult = Assert<Equal<typeof result, Direct.ContractResult<void, Direct.FieldSetError>>>

if (result.ok) {
  const value: void = result.value
  void value
  // @ts-expect-error success has no error member
  result.error
} else {
  const error: Direct.FieldSetError = result.error
  void error
  // @ts-expect-error failure has no value member
  result.value
}

const directResult = LLM.validateExactFieldSet({ anything: true } as unknown, specification, "payload")
type _RootAndDirectResultMatch = Assert<Equal<typeof directResult, typeof result>>
type _RootAndDirectSpecificationMatch = Assert<
  Equal<LLM.ExactFieldSetSpecification<unknown>, Direct.ExactFieldSetSpecification<unknown>>
>

const literalSpecification = {
  kind: "literal",
  value: literal,
} as const satisfies Direct.ExactFieldSetSpecification<number>
void literalSpecification

const invalidMinimum: Direct.ExactFieldSetSpecification<number> = {
  kind: "safe-integer",
  // @ts-expect-error raw number cannot replace branded SafeInteger
  minimum: 0,
}
void invalidMinimum

const invalidLiteral: Direct.ExactFieldSetSpecification<number> = {
  kind: "literal",
  // @ts-expect-error raw number cannot replace branded SafeNonNegativeInt
  value: 1,
}
void invalidLiteral

const invalidOrder: Direct.ExactFieldSetSpecification<readonly string[]> = {
  kind: "array",
  element: { kind: "string", validate: () => true },
  // @ts-expect-error array order set is closed
  order: "sorted",
}
void invalidOrder

const invalidKind: Direct.ExactFieldSetSpecification<unknown> = {
  // @ts-expect-error specification kind set is closed
  kind: "record",
  fields: {},
}
void invalidKind

const invalidError: Direct.FieldSetError = {
  kind: "field-set",
  // @ts-expect-error FieldSetError issue set remains closed
  issue: "invalid",
  path: "$",
}
void invalidError

// @ts-expect-error exact validator returns ContractResult, not boolean
const booleanShortcut: boolean = LLM.validateExactFieldSet({}, specification)
void booleanShortcut

// @ts-expect-error exact validator does not return raw void
const rawVoid: void = LLM.validateExactFieldSet({}, specification)
void rawVoid
