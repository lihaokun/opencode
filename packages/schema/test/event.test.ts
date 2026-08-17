import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { FastCheck } from "effect/testing"
import { Event } from "../src/event"
import { SafePositiveInt, type ContractResult, type EventDefinitionError } from "../src/llm"

const eventVersion = Schema.decodeUnknownSync(SafePositiveInt)

function initializeEventDefinition<A>(result: ContractResult<A, EventDefinitionError>): A {
  if (!result.ok) throw new globalThis.Error("Event definition initialization failed", { cause: result.error })
  return result.value
}

function expectFailure(
  result: ContractResult<unknown, EventDefinitionError>,
  issue: EventDefinitionError["issue"],
  path: string,
) {
  expect(result).toEqual({
    ok: false,
    error: {
      kind: "event-definition",
      issue,
      path,
    },
  })
}

const defineUnknown = Event.define as (input: unknown) => ContractResult<Event.Definition, EventDefinitionError>

describe("event definitions", () => {
  test("definition is pure and defaults publication to public", () => {
    const definitions = Event.inventory()
    const definition = initializeEventDefinition(
      Event.define({ type: "test.pure", schema: { value: Schema.String } }),
    )
    const explicitlyUndefined = initializeEventDefinition(
      Event.define({
        type: "test.explicitly-undefined-publication",
        publication: undefined,
        schema: { value: Schema.String },
      }),
    )

    expect(definitions).toEqual([])
    expect(definition.type).toBe("test.pure")
    expect(definition.publication).toBe("public")
    expect(explicitlyUndefined.publication).toBe("public")
    expect(definition.durable).toBeUndefined()
    expect(Object.hasOwn(definition, "durable")).toBe(true)
    expect(Reflect.getOwnPropertyDescriptor(definition, "durable")?.enumerable).toBe(false)
    expect(Object.isFrozen(definition)).toBe(true)
  })

  test("keeps publication metadata outside the event wire shape", () => {
    const publicDefinition = initializeEventDefinition(
      Event.define({
        type: "test.explicit-public",
        publication: "public",
        schema: { value: Schema.String },
      }),
    )
    const internalDefinition = initializeEventDefinition(
      Event.define({
        type: "test.internal",
        publication: "internal",
        schema: { value: Schema.String },
      }),
    )

    expect(publicDefinition.publication).toBe("public")
    expect(internalDefinition.publication).toBe("internal")

    const decoded = Schema.decodeUnknownSync(internalDefinition)({
      id: Event.ID.create(),
      type: "test.internal",
      publication: "internal",
      data: { value: "hello" },
    })
    const encoded = Schema.encodeSync(internalDefinition)(decoded)
    expect(decoded).not.toHaveProperty("publication")
    expect(encoded).not.toHaveProperty("publication")
    expect(encoded.data).toEqual({ value: "hello" })
  })

  test("freezes durable metadata built from a safe positive version", () => {
    const definition = initializeEventDefinition(
      Event.define({
        type: "test.durable-metadata",
        durable: { aggregate: "id", version: eventVersion(1) },
        schema: { id: Schema.String },
      }),
    )

    expect(definition.durable as unknown).toEqual({ aggregate: "id", version: 1 })
    expect(Object.isFrozen(definition.durable)).toBe(true)
    expect(Object.isFrozen(definition.data)).toBe(true)
    expect(Object.isFrozen(definition.data.fields)).toBe(true)
  })

  test("returns exact typed failures for invalid scalar metadata", () => {
    expectFailure(defineUnknown({ type: "", schema: {} }), "invalid-type", "type")
    expectFailure(defineUnknown({ type: 1, schema: {} }), "invalid-type", "type")
    expectFailure(
      defineUnknown({ type: "test.invalid-publication", publication: "partner", schema: {} }),
      "invalid-publication",
      "publication",
    )

    for (const version of [0, -0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expectFailure(
        defineUnknown({
          type: "test.invalid-version",
          durable: { aggregate: "id", version },
          schema: { id: Schema.String },
        }),
        "invalid-durable-version",
        "durable.version",
      )
    }

    expectFailure(
      defineUnknown({
        type: "test.aggregate-missing",
        durable: { aggregate: "missing", version: 1 },
        schema: { id: Schema.String },
      }),
      "aggregate-field-missing",
      "durable.aggregate",
    )

    const inheritedPublication = Object.assign(Object.create({ publication: "internal" }), {
      type: "test.inherited-publication",
      schema: { value: Schema.String },
    })
    expectFailure(
      defineUnknown(inheritedPublication),
      "schema-construction-failed",
      "publication",
    )

    const inheritedDurable = Object.assign(
      Object.create({ durable: { aggregate: "id", version: 1 } }),
      {
        type: "test.inherited-durable",
        schema: { id: Schema.String },
      },
    )
    expectFailure(defineUnknown(inheritedDurable), "schema-construction-failed", "durable")
  })

  test("fails closed for invalid schema members and hostile reflection", () => {
    expectFailure(
      defineUnknown({ type: "test.invalid-member", schema: { value: "not-a-schema" } }),
      "schema-construction-failed",
      "schema.value",
    )

    const accessorFields = {}
    Object.defineProperty(accessorFields, "value", {
      enumerable: true,
      get() {
        throw new globalThis.Error("must not invoke schema accessor")
      },
    })
    expectFailure(
      defineUnknown({ type: "test.accessor", schema: accessorFields }),
      "schema-construction-failed",
      "schema.value",
    )

    const hostileFields = new Proxy(
      { value: Schema.String },
      {
        ownKeys() {
          throw new globalThis.Error("hostile reflection trap")
        },
      },
    )
    expectFailure(
      defineUnknown({ type: "test.hostile", schema: hostileFields }),
      "schema-construction-failed",
      "schema",
    )

    const revoked = Proxy.revocable({ type: "test.revoked", schema: {} }, {})
    revoked.revoke()
    expectFailure(defineUnknown(revoked.proxy), "schema-construction-failed", "schema")
  })

  test("preserves latest and durable inventory compatibility", () => {
    const historical = initializeEventDefinition(
      Event.define({
        type: "test.versioned",
        durable: { aggregate: "id", version: eventVersion(1) },
        schema: { id: Schema.String },
      }),
    )
    const current = initializeEventDefinition(
      Event.define({
        type: "test.versioned",
        durable: { aggregate: "id", version: eventVersion(2) },
        schema: { id: Schema.String, value: Schema.String },
      }),
    )

    expect(Event.latest([historical, current]).get(current.type)).toBe(current)
    expect(Event.latest([current, historical]).get(current.type)).toBe(current)
    expect(Event.durable([historical, current]).get("test.versioned.1")).toBe(historical)
    expect(Event.durable([historical, current]).get("test.versioned.2")).toBe(current)
  })
})

describe("event publication partition", () => {
  test("preserves identity and order in disjoint frozen outputs", () => {
    const firstPublic = initializeEventDefinition(
      Event.define({ type: "test.partition.public.1", schema: { value: Schema.String } }),
    )
    const internal = initializeEventDefinition(
      Event.define({
        type: "test.partition.internal",
        publication: "internal",
        schema: { value: Schema.String },
      }),
    )
    const secondPublic = initializeEventDefinition(
      Event.define({ type: "test.partition.public.2", schema: { value: Schema.String } }),
    )

    const partition = Event.partitionDefinitionsByPublication([firstPublic, internal, secondPublic])
    expect(partition.ok).toBe(true)
    if (!partition.ok) return

    expect(partition.value.public as readonly unknown[]).toEqual([firstPublic, secondPublic])
    expect(partition.value.internal as readonly unknown[]).toEqual([internal])
    expect(partition.value.public[0] as unknown).toBe(firstPublic)
    expect(partition.value.public[1] as unknown).toBe(secondPublic)
    expect(partition.value.internal[0] as unknown).toBe(internal)
    expect(Object.isFrozen(partition.value)).toBe(true)
    expect(Object.isFrozen(partition.value.public)).toBe(true)
    expect(Object.isFrozen(partition.value.internal)).toBe(true)
  })

  test("partitions every generated finite unique definition list like source filters", () => {
    FastCheck.assert(
      FastCheck.property(FastCheck.array(FastCheck.boolean(), { maxLength: 25 }), (publications) => {
        const definitions = publications.map((isPublic, index) =>
          initializeEventDefinition(
            Event.define({
              type: `test.property.${index}`,
              publication: isPublic ? "public" : "internal",
              schema: { value: Schema.String },
            }),
          ),
        )
        const result = Event.partitionDefinitionsByPublication(definitions)
        if (!result.ok) return false
        const expectedPublic = definitions.filter((item) => item.publication === "public")
        const expectedInternal = definitions.filter((item) => item.publication === "internal")
        return (
          result.value.public.length === expectedPublic.length &&
          result.value.internal.length === expectedInternal.length &&
          result.value.public.every((item, index) => item === expectedPublic[index]) &&
          result.value.internal.every((item, index) => item === expectedInternal[index])
        )
      }),
      { numRuns: 200 },
    )
  })

  test("rejects duplicate latest and versioned keys across publication classes", () => {
    const duplicatePublic = initializeEventDefinition(
      Event.define({ type: "test.duplicate", schema: { value: Schema.String } }),
    )
    const duplicateInternal = initializeEventDefinition(
      Event.define({
        type: "test.duplicate",
        publication: "internal",
        schema: { value: Schema.String },
      }),
    )
    expectFailure(
      Event.partitionDefinitionsByPublication([duplicatePublic, duplicateInternal]),
      "duplicate-type",
      "definitions[1].type",
    )

    const firstVersion = initializeEventDefinition(
      Event.define({
        type: "test.duplicate-version",
        durable: { aggregate: "id", version: eventVersion(1) },
        schema: { id: Schema.String },
      }),
    )
    const duplicateVersion = initializeEventDefinition(
      Event.define({
        type: "test.duplicate-version",
        publication: "internal",
        durable: { aggregate: "id", version: eventVersion(1) },
        schema: { id: Schema.String },
      }),
    )
    expectFailure(
      Event.partitionDefinitionsByPublication([firstVersion, duplicateVersion]),
      "duplicate-versioned-type",
      "definitions[1].durable.version",
    )
  })

  test("allows distinct durable versions of the same type", () => {
    const historical = initializeEventDefinition(
      Event.define({
        type: "test.partition-history",
        durable: { aggregate: "id", version: eventVersion(1) },
        schema: { id: Schema.String },
      }),
    )
    const current = initializeEventDefinition(
      Event.define({
        type: "test.partition-history",
        durable: { aggregate: "id", version: eventVersion(2) },
        schema: { id: Schema.String, value: Schema.String },
      }),
    )

    const partition = Event.partitionDefinitionsByPublication([current, historical])
    expect(partition.ok).toBe(true)
    if (!partition.ok) return
    expect(partition.value.public as readonly unknown[]).toEqual([current, historical])
    expect(Event.latest(partition.value.public).get("test.partition-history")).toBe(current)
  })

  test("fails closed for unknown or mutable publication metadata", () => {
    const malformed = {
      type: "test.partition.unknown",
      publication: "partner",
      data: Schema.Struct({ value: Schema.String }),
    } as unknown as Event.Definition

    expectFailure(
      Event.partitionDefinitionsByPublication([malformed]),
      "invalid-publication",
      "definitions[0].publication",
    )

    const frozenData = initializeEventDefinition(
      Event.define({ type: "test.partition.mutable-data", schema: { value: Schema.String } }),
    ).data
    const mutable = {
      type: "test.partition.mutable",
      publication: "public",
      data: frozenData,
    } as unknown as Event.Definition
    expectFailure(
      Event.partitionDefinitionsByPublication([mutable]),
      "public-internal-leak",
      "definitions[0].publication",
    )

    const lookalikeType = "test.partition.frozen-lookalike" as const
    const frozenLookalike = Object.freeze(
      Object.assign(
        Schema.Struct({
          id: Event.ID,
          type: Schema.Literal(lookalikeType),
          data: frozenData,
        }),
        {
          type: lookalikeType,
          publication: "public" as const,
          data: frozenData,
        },
      ),
    ) as unknown as Event.Definition
    expectFailure(
      Event.partitionDefinitionsByPublication([frozenLookalike]),
      "public-internal-leak",
      "definitions[0].publication",
    )

    const owned = initializeEventDefinition(
      Event.define({ type: "test.partition.proxy-target", schema: { value: Schema.String } }),
    )
    const proxy = Proxy.revocable(owned, {})
    expectFailure(
      Event.partitionDefinitionsByPublication([proxy.proxy]),
      "public-internal-leak",
      "definitions[0].publication",
    )
    proxy.revoke()

    const initialOwnedPartition = Event.partitionDefinitionsByPublication([owned])
    expect(initialOwnedPartition.ok).toBe(true)
    const definitionPrototype = Object.getPrototypeOf(owned)
    const previousDurable = Reflect.getOwnPropertyDescriptor(definitionPrototype, "durable")
    Reflect.defineProperty(definitionPrototype, "durable", {
      configurable: true,
      value: { aggregate: "missing", version: 0 },
    })
    try {
      expect(owned.durable).toBeUndefined()
      const partitionAfterInjection = Event.partitionDefinitionsByPublication([owned])
      expect(partitionAfterInjection.ok).toBe(true)
      if (partitionAfterInjection.ok) {
        expect(Event.durable(partitionAfterInjection.value.public).size).toBe(0)
      }
    } finally {
      if (previousDurable === undefined) Reflect.deleteProperty(definitionPrototype, "durable")
      else Reflect.defineProperty(definitionPrototype, "durable", previousDurable)
    }

    const malformedData = Schema.Struct({ value: Schema.String })
    Reflect.defineProperty(malformedData.fields, "value", {
      enumerable: true,
      value: "not-a-schema",
    })
    Object.freeze(malformedData.fields)
    Object.freeze(malformedData)
    const malformedDefinition = Object.freeze({
      type: "test.partition.malformed-data",
      publication: "public",
      data: malformedData,
    }) as unknown as Event.Definition
    expectFailure(
      Event.partitionDefinitionsByPublication([malformedDefinition]),
      "schema-construction-failed",
      "definitions[0].data.fields.value",
    )

    const unboundedLength = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") return Number.POSITIVE_INFINITY
        return Reflect.get(target, property, receiver)
      },
    }) as unknown as readonly Event.Definition[]
    expectFailure(
      Event.partitionDefinitionsByPublication(unboundedLength),
      "schema-construction-failed",
      "definitions.length",
    )
  })
})
