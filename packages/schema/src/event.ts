export * as Event from "./event"

import { Schema } from "effect"
import { optional } from "./schema"
import { ascending } from "./identifier"
import { Location } from "./location"
import { statics } from "./schema"
import type { Brand, ContractResult, EventDefinitionError, SafePositiveInt } from "./llm"

export const ID = Schema.String.check(Schema.isStartsWith("evt_")).pipe(
  Schema.brand("Event.ID"),
  statics((schema) => ({ create: () => schema.make("evt_" + ascending()) })),
)
export type ID = typeof ID.Type

export type Publication = "public" | "internal"

type EventValue<Type extends string, DataSchema extends Schema.Codec<unknown, unknown>> = {
  readonly id: ID
  readonly type: Type
  readonly data: Schema.Schema.Type<DataSchema>
  readonly durable?: {
    readonly aggregateID: string
    readonly seq: number
    readonly version: number
  }
  readonly location?: Location.Ref
  readonly metadata?: Record<string, unknown>
}

type EventEncoded<Type extends string, DataSchema extends Schema.Codec<unknown, unknown>> = {
  readonly id: Schema.Codec.Encoded<typeof ID>
  readonly type: Type
  readonly data: Schema.Codec.Encoded<DataSchema>
  readonly durable?: {
    readonly aggregateID: string
    readonly seq: number
    readonly version: number
  }
  readonly location?: Schema.Codec.Encoded<typeof Location.Ref>
  readonly metadata?: Record<string, unknown>
}

export type Definition<
  Type extends string = string,
  DataSchema extends Schema.Codec<unknown, unknown> = Schema.Codec<unknown, unknown>,
> = Schema.Codec<EventValue<Type, DataSchema>, EventEncoded<Type, DataSchema>> & {
  readonly type: Type
  readonly publication: Publication
  readonly durable?: {
    readonly version: SafePositiveInt
    readonly aggregate: string
  }
  readonly data: DataSchema
}

export type PublicEventDefinitionV1<D extends Definition = Definition> = D &
  Readonly<{ publication: "public" }> &
  Brand<"PublicEventDefinitionV1">

export type Data<D extends Definition> = Schema.Schema.Type<D["data"]>

export type Payload<D extends Definition = Definition> = {
  readonly id: ID
  readonly type: D["type"]
  readonly data: Data<D>
  readonly durable?: {
    readonly aggregateID: string
    readonly seq: number
    readonly version: number
  }
  readonly location?: Location.Ref
  readonly metadata?: Record<string, unknown>
}

type DefinitionFields = Readonly<Record<string, unknown>>
type ValidatedDefinitionFields<Fields extends DefinitionFields> = {
  readonly [Key in keyof Fields]: Extract<Fields[Key], Schema.Codec<unknown, unknown>>
}
type DefinitionIssue = EventDefinitionError["issue"]

const ownedDefinitions = new WeakSet<object>()

function definitionFailure(issue: DefinitionIssue, path: string): ContractResult<never, EventDefinitionError> {
  return {
    ok: false,
    error: {
      kind: "event-definition",
      issue,
      path,
    },
  }
}

function dataProperty(object: object, key: PropertyKey) {
  const descriptor = Reflect.getOwnPropertyDescriptor(object, key)
  return descriptor !== undefined && "value" in descriptor ? descriptor : undefined
}

function schemaFieldPath(key: PropertyKey) {
  return typeof key === "symbol" ? `schema.[${String(key)}]` : `schema.${String(key)}`
}

export function define<
  const Type extends string,
  const Fields extends DefinitionFields,
>(input: Readonly<{
  readonly type: Type
  readonly publication?: Publication
  readonly durable?: Readonly<{
    readonly version: SafePositiveInt
    readonly aggregate: keyof Fields & string
  }>
  readonly schema: Fields
}>): ContractResult<Definition<Type, Schema.Struct<ValidatedDefinitionFields<Fields>>>, EventDefinitionError> {
  // # Step P1: normalize source-level publication metadata
  if (typeof input !== "object" || input === null) return definitionFailure("invalid-type", "type")

  try {
    const typeProperty = dataProperty(input, "type")
    if (typeProperty === undefined || typeof typeProperty.value !== "string" || typeProperty.value.length === 0) {
      return definitionFailure("invalid-type", "type")
    }
    const type = typeProperty.value as Type

    const publicationProperty = Reflect.getOwnPropertyDescriptor(input, "publication")
    if (
      (publicationProperty === undefined && Reflect.has(input, "publication")) ||
      (publicationProperty !== undefined && !("value" in publicationProperty))
    ) {
      return definitionFailure("schema-construction-failed", "publication")
    }
    const publication =
      publicationProperty === undefined || publicationProperty.value === undefined ? "public" : publicationProperty.value
    if (publication !== "public" && publication !== "internal") {
      return definitionFailure("invalid-publication", "publication")
    }

    const schemaProperty = dataProperty(input, "schema")
    if (schemaProperty === undefined || typeof schemaProperty.value !== "object" || schemaProperty.value === null) {
      return definitionFailure("schema-construction-failed", "schema")
    }
    const fields = schemaProperty.value as Fields
    const fieldKeys = Reflect.ownKeys(fields)
    const normalizedFields = {} as Record<PropertyKey, Schema.Codec<unknown, unknown>>
    for (const key of fieldKeys) {
      const field = dataProperty(fields, key)
      if (field === undefined || !field.enumerable || !Schema.isSchema(field.value)) {
        return definitionFailure("schema-construction-failed", schemaFieldPath(key))
      }
      Reflect.defineProperty(normalizedFields, key, {
        configurable: false,
        enumerable: true,
        value: field.value,
        writable: false,
      })
    }

    const durableProperty = Reflect.getOwnPropertyDescriptor(input, "durable")
    if (
      (durableProperty === undefined && Reflect.has(input, "durable")) ||
      (durableProperty !== undefined && !("value" in durableProperty))
    ) {
      return definitionFailure("schema-construction-failed", "durable")
    }
    const durableInput = durableProperty === undefined ? undefined : durableProperty.value
    let durableMetadata: Definition["durable"]
    if (durableInput !== undefined) {
      if (typeof durableInput !== "object" || durableInput === null) {
        return definitionFailure("invalid-durable-version", "durable.version")
      }
      const versionProperty = dataProperty(durableInput, "version")
      const version = versionProperty?.value
      if (
        typeof version !== "number" ||
        !Number.isSafeInteger(version) ||
        Object.is(version, -0) ||
        version <= 0
      ) {
        return definitionFailure("invalid-durable-version", "durable.version")
      }
      const aggregateProperty = dataProperty(durableInput, "aggregate")
      const aggregate = aggregateProperty?.value
      if (typeof aggregate !== "string" || !fieldKeys.includes(aggregate)) {
        return definitionFailure("aggregate-field-missing", "durable.aggregate")
      }
      durableMetadata = Object.freeze({
        version: version as SafePositiveInt,
        aggregate,
      })
    }

    const data = Object.freeze(
      Schema.Struct(Object.freeze(normalizedFields) as ValidatedDefinitionFields<Fields>),
    )
    const definition = Schema.Struct({
      id: ID,
      metadata: optional(Schema.Record(Schema.String, Schema.Unknown)),
      type: Schema.Literal(type),
      durable: optional(Schema.Struct({ aggregateID: Schema.String, seq: Schema.Int, version: Schema.Int })),
      location: optional(Location.Ref),
      data,
    })
      .annotate({ identifier: type })
      .pipe(
        statics(() => ({
          type,
          publication,
          ...(durableMetadata === undefined ? {} : { durable: durableMetadata }),
          data,
        })),
      ) satisfies Definition<Type, typeof data>

    if (
      durableMetadata === undefined &&
      !Reflect.defineProperty(definition, "durable", {
        configurable: false,
        enumerable: false,
        value: undefined,
        writable: false,
      })
    ) {
      return definitionFailure("schema-construction-failed", "durable")
    }

    const value = Object.freeze(definition)
    ownedDefinitions.add(value)
    return {
      ok: true,
      value,
    }
  } catch {
    return definitionFailure("schema-construction-failed", "schema")
  }
}

export function partitionDefinitionsByPublication<D extends Definition>(
  definitions: readonly D[],
): ContractResult<
  Readonly<{
    public: readonly PublicEventDefinitionV1<D>[]
    internal: readonly (D & Readonly<{ publication: "internal" }>)[]
  }>,
  EventDefinitionError
> {
  // # Step P2: partition public and internal definitions exactly once
  const publicDefinitions: PublicEventDefinitionV1<D>[] = []
  const internalDefinitions: (D & Readonly<{ publication: "internal" }>)[] = []
  const typeVersions = new Map<string, number | undefined>()
  const versionedTypes = new Set<string>()
  let currentIndex = 0

  try {
    const length = definitions.length
    if (!Number.isSafeInteger(length) || length < 0) {
      return definitionFailure("schema-construction-failed", "definitions.length")
    }
    for (currentIndex = 0; currentIndex < length; currentIndex++) {
      const index = currentIndex
      const definition = definitions[index]
      if (typeof definition !== "object" || definition === null) {
        return definitionFailure("schema-construction-failed", `definitions[${index}]`)
      }

      const typeProperty = dataProperty(definition, "type")
      const type = typeProperty?.value
      if (typeof type !== "string" || type.length === 0) {
        return definitionFailure("invalid-type", `definitions[${index}].type`)
      }

      const publicationProperty = dataProperty(definition, "publication")
      const publication = publicationProperty?.value
      if (publication !== "public" && publication !== "internal") {
        return definitionFailure("invalid-publication", `definitions[${index}].publication`)
      }

      const data = dataProperty(definition, "data")?.value
      const fields =
        typeof data === "object" && data !== null ? dataProperty(data, "fields")?.value : undefined
      if (
        !Schema.isSchema(data) ||
        typeof fields !== "object" ||
        fields === null ||
        !Object.isFrozen(data) ||
        !Object.isFrozen(fields)
      ) {
        return definitionFailure("schema-construction-failed", `definitions[${index}].data`)
      }
      const fieldKeys = Reflect.ownKeys(fields)
      for (const key of fieldKeys) {
        const field = dataProperty(fields, key)
        if (field === undefined || !field.enumerable || !Schema.isSchema(field.value)) {
          return definitionFailure(
            "schema-construction-failed",
            `definitions[${index}].data.fields.${typeof key === "symbol" ? `[${String(key)}]` : String(key)}`,
          )
        }
      }
      if (!Schema.isSchema(definition) || !ownedDefinitions.has(definition)) {
        return definitionFailure("public-internal-leak", `definitions[${index}].publication`)
      }

      const durableProperty = Reflect.getOwnPropertyDescriptor(definition, "durable")
      if (
        (durableProperty === undefined && Reflect.has(definition, "durable")) ||
        (durableProperty !== undefined && !("value" in durableProperty))
      ) {
        return definitionFailure("schema-construction-failed", `definitions[${index}].durable`)
      }
      const durable = durableProperty === undefined ? undefined : durableProperty.value
      let version: number | undefined
      if (durable !== undefined) {
        if (typeof durable !== "object" || durable === null) {
          return definitionFailure("invalid-durable-version", `definitions[${index}].durable.version`)
        }
        version = dataProperty(durable, "version")?.value
        if (
          typeof version !== "number" ||
          !Number.isSafeInteger(version) ||
          Object.is(version, -0) ||
          version <= 0
        ) {
          return definitionFailure("invalid-durable-version", `definitions[${index}].durable.version`)
        }
        const aggregate = dataProperty(durable, "aggregate")?.value
        if (typeof aggregate !== "string" || !fieldKeys.includes(aggregate)) {
          return definitionFailure("aggregate-field-missing", `definitions[${index}].durable.aggregate`)
        }
        if (!Object.isFrozen(durable)) {
          return definitionFailure("public-internal-leak", `definitions[${index}].durable`)
        }
        const versioned = versionedType(type, version)
        if (versionedTypes.has(versioned)) {
          return definitionFailure("duplicate-versioned-type", `definitions[${index}].durable.version`)
        }
        versionedTypes.add(versioned)
      }

      if (typeVersions.has(type)) {
        const existingVersion = typeVersions.get(type)
        if (existingVersion === undefined || version === undefined) {
          return definitionFailure("duplicate-type", `definitions[${index}].type`)
        }
      } else {
        typeVersions.set(type, version)
      }

      if (!Object.isFrozen(definition)) {
        return definitionFailure("public-internal-leak", `definitions[${index}].publication`)
      }

      if (publication === "public") {
        publicDefinitions.push(definition as PublicEventDefinitionV1<D>)
      } else if (publication === "internal") {
        internalDefinitions.push(definition as D & Readonly<{ publication: "internal" }>)
      } else {
        return definitionFailure("public-internal-leak", `definitions[${index}].publication`)
      }
    }

    return {
      ok: true,
      value: Object.freeze({
        public: Object.freeze(publicDefinitions),
        internal: Object.freeze(internalDefinitions),
      }),
    }
  } catch {
    return definitionFailure("schema-construction-failed", `definitions[${currentIndex}]`)
  }
}

export function inventory<const Definitions extends ReadonlyArray<Definition>>(...definitions: Definitions) {
  return Object.freeze(definitions)
}

export function latest(definitions: ReadonlyArray<Definition>) {
  return readonlyMap(
    definitions.reduce((result, definition) => {
      const existing = result.get(definition.type)
      if (!existing) {
        result.set(definition.type, definition)
        return result
      }
      if (definition.durable && existing.durable && definition.durable.version !== existing.durable.version) {
        if (definition.durable.version > existing.durable.version) result.set(definition.type, definition)
        return result
      }
      if (definition !== existing) throw new Error(`Duplicate latest event definition for ${definition.type}`)
      return result
    }, new Map<string, Definition>()),
  )
}

export function versionedType(type: string, version: number) {
  return `${type}.${version}`
}

export function durable<const Definitions extends ReadonlyArray<Definition>>(definitions: Definitions) {
  return readonlyMap(
    definitions.reduce((result, definition) => {
      if (!definition.durable) return result
      const key = versionedType(definition.type, definition.durable.version)
      if (result.has(key)) throw new Error(`Duplicate durable event definition for ${key}`)
      result.set(key, definition)
      return result
    }, new Map<string, Definitions[number]>()),
  )
}

function readonlyMap<Key, Value>(map: Map<Key, Value>): ReadonlyMap<Key, Value> {
  const result: ReadonlyMap<Key, Value> = Object.freeze({
    get size() {
      return map.size
    },
    entries: () => map.entries(),
    forEach: (callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void, thisArg?: unknown) =>
      map.forEach((value, key) => callback.call(thisArg, value, key, result)),
    get: (key: Key) => map.get(key),
    has: (key: Key) => map.has(key),
    keys: () => map.keys(),
    values: () => map.values(),
    [Symbol.iterator]: () => map[Symbol.iterator](),
  })
  return result
}
