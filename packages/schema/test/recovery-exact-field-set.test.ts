import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { FastCheck } from "effect/testing"
import { runInNewContext } from "node:vm"
import { LLM } from "../src"
import * as Direct from "../src/llm"

const safeInteger = Schema.decodeUnknownSync(Direct.SafeInteger)
const safeNonNegativeInt = Schema.decodeUnknownSync(Direct.SafeNonNegativeInt)

const stringSpec = (validate: (value: string) => boolean = () => true) =>
  ({ kind: "string", validate }) as const satisfies Direct.ExactFieldSetSpecification<string>

const integerSpec = (minimum?: number, maximum?: number) =>
  ({
    kind: "safe-integer",
    ...(minimum === undefined ? {} : { minimum: safeInteger(minimum) }),
    ...(maximum === undefined ? {} : { maximum: safeInteger(maximum) }),
  }) as const satisfies Direct.ExactFieldSetSpecification<number>

const literalSpec = (value: null | boolean | string | number) =>
  ({
    kind: "literal",
    value: typeof value === "number" ? safeNonNegativeInt(value) : value,
  }) as const satisfies Direct.ExactFieldSetSpecification<typeof value>

const expectSuccess = (result: Direct.ContractResult<void, Direct.FieldSetError>) => {
  expect(result).toEqual({ ok: true, value: undefined })
}

const expectFailure = (result: Direct.ContractResult<void, Direct.FieldSetError>, error: Direct.FieldSetError) => {
  expect(result).toEqual({ ok: false, error })
}

describe("recovery exact field sets", () => {
  test("exports one exact validator identity and validates every specification kind", () => {
    expect(LLM.validateExactFieldSet).toBe(Direct.validateExactFieldSet)

    for (const [value, specification] of [
      [null, literalSpec(null)],
      [true, literalSpec(true)],
      ["literal", literalSpec("literal")],
      [3, literalSpec(3)],
      ["field", stringSpec((input) => input.startsWith("f"))],
      [0, integerSpec(-1, 1)],
    ] as const) {
      expectSuccess(Direct.validateExactFieldSet(value, specification))
    }

    const arraySpecification = {
      kind: "array",
      element: integerSpec(0),
      order: "semantic",
    } as const satisfies Direct.ExactFieldSetSpecification<readonly number[]>
    expectSuccess(Direct.validateExactFieldSet([2, 1, 0], arraySpecification))

    const objectSpecification = {
      kind: "object",
      required: ["name", "count"],
      optional: ["note"],
      fields: {
        name: stringSpec(),
        count: integerSpec(0),
        note: stringSpec(),
      },
    } as const satisfies Direct.ExactFieldSetSpecification<{
      readonly name: string
      readonly count: number
      readonly note?: string
    }>
    expectSuccess(Direct.validateExactFieldSet({ name: "item", count: 1 }, objectSpecification))
    expectSuccess(Direct.validateExactFieldSet({ name: "item", count: 1, note: "kept" }, objectSpecification))
  })

  test("returns deterministic missing, extra, nullability, and wrong-set errors", () => {
    const specification = {
      kind: "object",
      required: ["kind", "value", "dash-key"],
      optional: [],
      fields: {
        kind: literalSpec("entry"),
        value: stringSpec(),
        "dash-key": stringSpec(),
      },
    } as const satisfies Direct.ExactFieldSetSpecification<unknown>

    expectFailure(Direct.validateExactFieldSet({ kind: "entry", "dash-key": "x" }, specification), {
      kind: "field-set",
      issue: "missing",
      path: "$",
      field: "value",
    })
    expectFailure(
      Direct.validateExactFieldSet({ kind: "entry", value: "x", "dash-key": "y", z: true, a: true }, specification),
      {
        kind: "field-set",
        issue: "extra",
        path: "$",
        field: "a",
      },
    )
    expectFailure(Direct.validateExactFieldSet({ kind: "entry", value: null, "dash-key": "x" }, specification), {
      kind: "field-set",
      issue: "nullability",
      path: "$.value",
    })
    expectFailure(Direct.validateExactFieldSet({ kind: "entry", value: "x", "dash-key": 1 }, specification), {
      kind: "field-set",
      issue: "wrong-set",
      path: '$["dash-key"]',
    })
    expectFailure(
      Direct.validateExactFieldSet({ kind: "wrong", value: "x", "dash-key": "y" }, specification, "payload"),
      {
        kind: "field-set",
        issue: "wrong-set",
        path: "payload.kind",
      },
    )
  })

  test("validates safe integer bounds without coercion", () => {
    const specification = integerSpec(-2, 2)
    for (const value of [-2, -1, 0, 1, 2]) {
      expectSuccess(Direct.validateExactFieldSet(value, specification))
    }
    for (const value of [
      -3,
      3,
      -0,
      1.5,
      Number.MIN_SAFE_INTEGER - 1,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      "1",
    ]) {
      expectFailure(Direct.validateExactFieldSet(value, specification), {
        kind: "field-set",
        issue: "wrong-set",
        path: "$",
      })
    }

    const reversedBounds = {
      kind: "safe-integer",
      minimum: safeInteger(2),
      maximum: safeInteger(1),
    } as const
    expectFailure(Direct.validateExactFieldSet(1, reversedBounds), {
      kind: "field-set",
      issue: "wrong-set",
      path: "$",
    })
  })

  test("distinguishes optional absence from forbidden null", () => {
    const specification = {
      kind: "object",
      required: ["required"],
      optional: ["optional", "nullable"],
      fields: {
        required: stringSpec(),
        optional: stringSpec(),
        nullable: literalSpec(null),
      },
    } as const satisfies Direct.ExactFieldSetSpecification<unknown>

    expectSuccess(Direct.validateExactFieldSet({ required: "yes" }, specification))
    expectSuccess(Direct.validateExactFieldSet({ required: "yes", nullable: null }, specification))
    expectFailure(Direct.validateExactFieldSet({ required: "yes", optional: null }, specification), {
      kind: "field-set",
      issue: "nullability",
      path: "$.optional",
    })

    let inheritedInvoked = false
    const inherited = Object.assign(
      Object.create({
        get optional() {
          inheritedInvoked = true
          throw new Error("must not invoke inherited optional accessor")
        },
      }),
      { required: "yes" },
    )
    expectFailure(Direct.validateExactFieldSet(inherited, specification), {
      kind: "field-set",
      issue: "extra",
      path: "$",
      field: "optional",
    })
    expect(inheritedInvoked).toBe(false)
  })

  test("selects one closed discriminator branch without fallback", () => {
    const aBranch = {
      kind: "object",
      required: ["kind", "value"],
      optional: [],
      fields: { kind: literalSpec("a"), value: stringSpec() },
    } as const satisfies Direct.ExactFieldSetSpecification<unknown>
    const bBranch = {
      kind: "object",
      required: ["kind", "count"],
      optional: [],
      fields: { kind: literalSpec("b"), count: integerSpec(0) },
    } as const satisfies Direct.ExactFieldSetSpecification<unknown>
    const specification = {
      kind: "union",
      discriminator: "kind",
      branches: { a: aBranch, b: bBranch },
    } as const satisfies Direct.ExactFieldSetSpecification<unknown>

    expectSuccess(Direct.validateExactFieldSet({ kind: "a", value: "x" }, specification))
    expectSuccess(Direct.validateExactFieldSet({ kind: "b", count: 1 }, specification))
    expectFailure(Direct.validateExactFieldSet({ value: "x" }, specification), {
      kind: "field-set",
      issue: "missing",
      path: "$",
      field: "kind",
    })
    expectFailure(Direct.validateExactFieldSet({ kind: "c", value: "x" }, specification), {
      kind: "field-set",
      issue: "wrong-set",
      path: "$.kind",
    })

    const hiddenDiscriminator = { value: "x" }
    Object.defineProperty(hiddenDiscriminator, "kind", { enumerable: false, value: "a" })
    expectFailure(Direct.validateExactFieldSet(hiddenDiscriminator, specification), {
      kind: "field-set",
      issue: "extra",
      path: "$",
      field: "kind",
    })

    let discriminatorInvoked = false
    const accessorDiscriminator = { value: "x" }
    Object.defineProperty(accessorDiscriminator, "kind", {
      enumerable: true,
      get() {
        discriminatorInvoked = true
        throw new Error("must not invoke discriminator accessor")
      },
    })
    expectFailure(Direct.validateExactFieldSet(accessorDiscriminator, specification), {
      kind: "field-set",
      issue: "wrong-set",
      path: "$.kind",
    })
    expect(discriminatorInvoked).toBe(false)
    expectFailure(Direct.validateExactFieldSet({ kind: "a", count: 1 }, specification), {
      kind: "field-set",
      issue: "extra",
      path: "$",
      field: "count",
    })
    expectFailure(Direct.validateExactFieldSet({ kind: "b", count: 1, value: "x" }, specification), {
      kind: "field-set",
      issue: "extra",
      path: "$",
      field: "value",
    })
  })

  test("rejects hidden, symbolic, inherited, and accessor authority fields without invoking accessors", () => {
    const specification = {
      kind: "object",
      required: ["value"],
      optional: [],
      fields: { value: stringSpec() },
    } as const satisfies Direct.ExactFieldSetSpecification<unknown>

    const symbolic = { value: "x", [Symbol("secret")]: true }
    expectFailure(Direct.validateExactFieldSet(symbolic, specification), {
      kind: "field-set",
      issue: "extra",
      path: "$",
      field: "[Symbol(secret)]",
    })

    let tagInvoked = false
    const tagged = { value: "x" }
    Object.defineProperty(tagged, Symbol.toStringTag, {
      enumerable: true,
      get() {
        tagInvoked = true
        throw new Error("must not invoke Symbol.toStringTag")
      },
    })
    expectFailure(Direct.validateExactFieldSet(tagged, specification), {
      kind: "field-set",
      issue: "extra",
      path: "$",
      field: "[Symbol(Symbol.toStringTag)]",
    })
    expect(tagInvoked).toBe(false)

    const hidden = { value: "x" }
    Object.defineProperty(hidden, "secret", { enumerable: false, value: true })
    expectFailure(Direct.validateExactFieldSet(hidden, specification), {
      kind: "field-set",
      issue: "extra",
      path: "$",
      field: "secret",
    })

    let invoked = false
    const accessor = {}
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get() {
        invoked = true
        throw new Error("must not invoke accessor")
      },
    })
    expectFailure(Direct.validateExactFieldSet(accessor, specification), {
      kind: "field-set",
      issue: "wrong-set",
      path: "$.value",
    })
    expect(invoked).toBe(false)

    const inherited = Object.create({ value: "inherited" })
    expectFailure(Direct.validateExactFieldSet(inherited, specification), {
      kind: "field-set",
      issue: "missing",
      path: "$",
      field: "value",
    })

    const customPrototype = Object.assign(Object.create({ realm: "custom" }), { value: "own" })
    expectSuccess(Direct.validateExactFieldSet(customPrototype, specification))
    const foreignRealm = runInNewContext('({ value: "own" })')
    expectSuccess(Direct.validateExactFieldSet(foreignRealm, specification))

    const emptySpecification = {
      kind: "object",
      required: [],
      optional: [],
      fields: {},
    } as const satisfies Direct.ExactFieldSetSpecification<unknown>
    expectFailure(Direct.validateExactFieldSet(new Date(0), emptySpecification), {
      kind: "field-set",
      issue: "wrong-set",
      path: "$",
    })
    expectFailure(Direct.validateExactFieldSet(new (class Value {})(), emptySpecification), {
      kind: "field-set",
      issue: "wrong-set",
      path: "$",
    })
    const ConstructorSpoof = class Value {}
    Object.defineProperty(ConstructorSpoof.prototype, "constructor", { value: Object })
    expectFailure(Direct.validateExactFieldSet(new ConstructorSpoof(), emptySpecification), {
      kind: "field-set",
      issue: "wrong-set",
      path: "$",
    })
    const DetachedConstructorSpoof = class Value {
      secret() {}
    }
    Object.setPrototypeOf(DetachedConstructorSpoof.prototype, null)
    Object.defineProperty(DetachedConstructorSpoof.prototype, "constructor", { value: Object })
    expectFailure(Direct.validateExactFieldSet(new DetachedConstructorSpoof(), emptySpecification), {
      kind: "field-set",
      issue: "wrong-set",
      path: "$",
    })
    const SpoofedObject = class Object {}
    expectFailure(Direct.validateExactFieldSet(new SpoofedObject(), emptySpecification), {
      kind: "field-set",
      issue: "wrong-set",
      path: "$",
    })
  })

  test("fails closed on hostile reflection, revoked proxies, and throwing validators", () => {
    const specification = {
      kind: "object",
      required: ["value"],
      optional: [],
      fields: { value: stringSpec() },
    } as const satisfies Direct.ExactFieldSetSpecification<unknown>

    const hostile = new Proxy(
      { value: "x" },
      {
        ownKeys() {
          throw new Error("hostile reflection trap")
        },
      },
    )
    expectFailure(Direct.validateExactFieldSet(hostile, specification), {
      kind: "field-set",
      issue: "wrong-set",
      path: "$",
    })

    const revoked = Proxy.revocable({ value: "x" }, {})
    revoked.revoke()
    expectFailure(Direct.validateExactFieldSet(revoked.proxy, specification), {
      kind: "field-set",
      issue: "wrong-set",
      path: "$",
    })

    expectFailure(
      Direct.validateExactFieldSet(
        "x",
        stringSpec(() => {
          throw new Error("validator failure")
        }),
      ),
      {
        kind: "field-set",
        issue: "wrong-set",
        path: "$",
      },
    )
  })

  test("rejects sparse, decorated, accessor, hostile-length, and cyclic arrays", () => {
    const specification = {
      kind: "array",
      element: integerSpec(0),
      order: "registry-fixed",
    } as const satisfies Direct.ExactFieldSetSpecification<readonly number[]>

    const sparse = new Array(2)
    sparse[0] = 1
    expectFailure(Direct.validateExactFieldSet(sparse, specification), {
      kind: "field-set",
      issue: "missing",
      path: "$",
      field: "1",
    })

    const decorated = [1] as number[] & { extra?: boolean }
    decorated.extra = true
    expectFailure(Direct.validateExactFieldSet(decorated, specification), {
      kind: "field-set",
      issue: "extra",
      path: "$",
      field: "extra",
    })

    const accessor: unknown[] = []
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() {
        throw new Error("must not invoke array accessor")
      },
    })
    Object.defineProperty(accessor, "length", { value: 1 })
    expectFailure(Direct.validateExactFieldSet(accessor, specification), {
      kind: "field-set",
      issue: "wrong-set",
      path: "$[0]",
    })

    const hostileLength = new Proxy([], {
      getOwnPropertyDescriptor(target, key) {
        if (key === "length") {
          return { configurable: false, enumerable: false, value: Number.POSITIVE_INFINITY, writable: true }
        }
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
    })
    expectFailure(Direct.validateExactFieldSet(hostileLength, specification), {
      kind: "field-set",
      issue: "wrong-set",
      path: "$",
    })

    const cyclic: unknown[] = []
    cyclic.push(cyclic)
    expectFailure(
      Direct.validateExactFieldSet(cyclic, {
        kind: "array",
        element: specification,
        order: "semantic",
      }),
      {
        kind: "field-set",
        issue: "wrong-set",
        path: "$[0]",
      },
    )
  })

  test("rejects malformed runtime specifications without raw throws", () => {
    const malformed = [
      null,
      { kind: "unknown" },
      { kind: "object", required: ["value", "value"], optional: [], fields: { value: stringSpec() } },
      { kind: "object", required: ["value"], optional: ["value"], fields: { value: stringSpec() } },
      { kind: "object", required: ["value"], optional: [], fields: {} },
      { kind: "union", discriminator: "kind", branches: {} },
      { kind: "array", element: stringSpec(), order: "sorted" },
      { kind: "string", validate: () => 1 },
      { kind: "safe-integer", minimum: 1, extra: true },
    ]
    for (const specification of malformed) {
      expectFailure(
        Direct.validateExactFieldSet({ value: "x" }, specification as Direct.ExactFieldSetSpecification<unknown>),
        {
          kind: "field-set",
          issue: "wrong-set",
          path: "$",
        },
      )
    }

    const malformedChild = { kind: "unknown" } as unknown as Direct.ExactFieldSetSpecification<unknown>
    for (const [value, specification] of [
      [
        {},
        {
          kind: "object",
          required: [],
          optional: ["unused"],
          fields: { unused: malformedChild },
        },
      ],
      [[], { kind: "array", element: malformedChild, order: "semantic" }],
      [
        { kind: "selected" },
        {
          kind: "union",
          discriminator: "kind",
          branches: {
            selected: {
              kind: "object",
              required: ["kind"],
              optional: [],
              fields: { kind: literalSpec("selected") },
            },
            unused: malformedChild,
          },
        },
      ],
    ] as const) {
      expectFailure(Direct.validateExactFieldSet(value, specification as Direct.ExactFieldSetSpecification<unknown>), {
        kind: "field-set",
        issue: "wrong-set",
        path: "$",
      })
    }

    const cyclicBranches: Record<string, Direct.ExactFieldSetSpecification<unknown>> = {}
    const cyclicUnion = {
      kind: "union",
      discriminator: "kind",
      branches: cyclicBranches,
    } as const satisfies Direct.ExactFieldSetSpecification<unknown>
    cyclicBranches.self = cyclicUnion
    expectFailure(Direct.validateExactFieldSet({ kind: "self" }, cyclicUnion), {
      kind: "field-set",
      issue: "wrong-set",
      path: "$",
    })

    let invoked = false
    const accessorSpecification = {}
    Object.defineProperty(accessorSpecification, "kind", {
      enumerable: true,
      get() {
        invoked = true
        throw new Error("must not invoke spec accessor")
      },
    })
    expectFailure(
      Direct.validateExactFieldSet("x", accessorSpecification as Direct.ExactFieldSetSpecification<unknown>),
      {
        kind: "field-set",
        issue: "wrong-set",
        path: "$",
      },
    )
    expect(invoked).toBe(false)

    const hostileSpecification = new Proxy(stringSpec(), {
      ownKeys() {
        throw new Error("hostile specification")
      },
    })
    expectFailure(Direct.validateExactFieldSet("x", hostileSpecification), {
      kind: "field-set",
      issue: "wrong-set",
      path: "$",
    })
  })

  test("does not mutate successful or failing inputs", () => {
    const specification = {
      kind: "object",
      required: ["value"],
      optional: [],
      fields: { value: stringSpec() },
    } as const satisfies Direct.ExactFieldSetSpecification<unknown>
    const success = Object.freeze({ value: "x" })
    const failure = { value: 1 }
    const successDescriptors = Object.getOwnPropertyDescriptors(success)
    const failureDescriptors = Object.getOwnPropertyDescriptors(failure)

    expectSuccess(Direct.validateExactFieldSet(success, specification))
    expectFailure(Direct.validateExactFieldSet(failure, specification), {
      kind: "field-set",
      issue: "wrong-set",
      path: "$.value",
    })
    expect(Object.getOwnPropertyDescriptors(success)).toEqual(successDescriptors)
    expect(Object.getOwnPropertyDescriptors(failure)).toEqual(failureDescriptors)
    expect(Object.isFrozen(success)).toBe(true)
    expect(Object.isFrozen(failure)).toBe(false)
  })

  test("terminates on deeply nested finite acyclic values without using the call stack", () => {
    const branches: Record<string, Direct.ExactFieldSetSpecification<unknown>> = {}
    const specification = {
      kind: "union",
      discriminator: "kind",
      branches,
    } as const satisfies Direct.ExactFieldSetSpecification<unknown>
    branches.end = {
      kind: "object",
      required: ["kind"],
      optional: [],
      fields: { kind: literalSpec("end") },
    }
    branches.next = {
      kind: "object",
      required: ["kind", "next"],
      optional: [],
      fields: { kind: literalSpec("next"), next: specification },
    }

    let value: unknown = { kind: "end" }
    for (let depth = 0; depth < 12_000; depth++) {
      value = { kind: "next", next: value }
    }

    expectSuccess(Direct.validateExactFieldSet(value, specification))
  })

  test("memoizes completed value and specification pairs in shared acyclic graphs", () => {
    let leafValidations = 0
    const branches: Record<string, Direct.ExactFieldSetSpecification<unknown>> = {}
    const specification = {
      kind: "union",
      discriminator: "kind",
      branches,
    } as const satisfies Direct.ExactFieldSetSpecification<unknown>
    branches.leaf = {
      kind: "object",
      required: ["kind", "payload"],
      optional: [],
      fields: {
        kind: literalSpec("leaf"),
        payload: stringSpec(() => {
          leafValidations++
          return true
        }),
      },
    }
    branches.node = {
      kind: "object",
      required: ["kind", "left", "right"],
      optional: [],
      fields: {
        kind: literalSpec("node"),
        left: specification,
        right: specification,
      },
    }

    let value: unknown = { kind: "leaf", payload: "x" }
    for (let depth = 0; depth < 20; depth++) {
      value = { kind: "node", left: value, right: value }
    }

    expectSuccess(Direct.validateExactFieldSet(value, specification))
    expect(leafValidations).toBe(1)
  })

  test("compiles reused specification nodes once per validation", () => {
    let ownKeyReads = 0
    const element = new Proxy(
      {
        kind: "object",
        required: [],
        optional: [],
        fields: {},
      } as const satisfies Direct.ExactFieldSetSpecification<unknown>,
      {
        ownKeys(target) {
          ownKeyReads++
          return Reflect.ownKeys(target)
        },
      },
    )
    const specification = {
      kind: "array",
      element,
      order: "semantic",
    } as const satisfies Direct.ExactFieldSetSpecification<unknown>

    expectSuccess(
      Direct.validateExactFieldSet(
        Array.from({ length: 100 }, () => ({})),
        specification,
      ),
    )
    expect(ownKeyReads).toBe(1)
  })

  test("validates generated finite values and detects exact missing or extra mutations", () => {
    const specification = {
      kind: "object",
      required: ["name", "count", "tags"],
      optional: [],
      fields: {
        name: stringSpec(),
        count: integerSpec(),
        tags: {
          kind: "array",
          element: stringSpec(),
          order: "semantic",
        },
      },
    } as const satisfies Direct.ExactFieldSetSpecification<unknown>

    FastCheck.assert(
      FastCheck.property(
        FastCheck.record({
          name: FastCheck.string(),
          count: FastCheck.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
          tags: FastCheck.array(FastCheck.string(), { maxLength: 20 }),
        }),
        (value) => {
          const valid = Direct.validateExactFieldSet(value, specification)
          const extra = Direct.validateExactFieldSet({ ...value, extra: true }, specification)
          const { name: _name, ...missingName } = value
          const missing = Direct.validateExactFieldSet(missingName, specification)
          return (
            valid.ok &&
            !extra.ok &&
            extra.error.issue === "extra" &&
            extra.error.field === "extra" &&
            !missing.ok &&
            missing.error.issue === "missing" &&
            missing.error.field === "name"
          )
        },
      ),
      { numRuns: 250 },
    )
  })
})
