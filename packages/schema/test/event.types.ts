import { Schema } from "effect"
import { Event } from "../src/event"
import { SafePositiveInt, type ContractResult, type EventDefinitionError } from "../src/llm"

type Assert<T extends true> = T
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assignable<A, B> = [A] extends [B] ? true : false

const version1 = Schema.decodeUnknownSync(SafePositiveInt)(1)
const broadFields: Readonly<Record<string, unknown>> = { value: Schema.String }
const broadResult = Event.define({ type: "test.types.broad-fields", schema: broadFields })
const broadContract: ContractResult<Event.Definition, EventDefinitionError> = broadResult
void broadContract

const result = Event.define({
  type: "test.types.public",
  durable: { aggregate: "id", version: version1 },
  schema: { id: Schema.String, value: Schema.String },
})

// @ts-expect-error ContractResult must be narrowed before definition metadata is used
result.type

function unwrap<A>(definition: ContractResult<A, EventDefinitionError>): A {
  if (definition.ok) return definition.value
  const error: EventDefinitionError = definition.error
  throw new globalThis.Error(error.issue)
}

const publicDefinition = unwrap(result)
const explicitPublicDefinition = unwrap(
  Event.define({
    type: "test.types.explicit-public",
    publication: "public",
    schema: { value: Schema.String },
  }),
)
const internalDefinition = unwrap(
  Event.define({
    type: "test.types.internal",
    publication: "internal",
    schema: { value: Schema.String },
  }),
)

const definition: Event.Definition = publicDefinition
const explicitDefinition: Event.Definition = explicitPublicDefinition
const internalAsDefinition: Event.Definition = internalDefinition
void definition
void explicitDefinition
void internalAsDefinition

Event.define({
  type: "test.types.raw-version",
  durable: {
    aggregate: "id",
    // @ts-expect-error raw number cannot replace SafePositiveInt
    version: 1,
  },
  schema: { id: Schema.String },
})

const partition = Event.partitionDefinitionsByPublication([publicDefinition, internalDefinition])
if (partition.ok) {
  const brandedPublic: Event.PublicEventDefinitionV1 = partition.value.public[0]!
  void brandedPublic

  // @ts-expect-error internal definitions cannot replace public definitions
  const internalAsPublic: Event.PublicEventDefinitionV1 = partition.value.internal[0]!
  void internalAsPublic
}

// @ts-expect-error a raw public Definition has not passed the owner partition boundary
const rawAsPublic: Event.PublicEventDefinitionV1 = publicDefinition
void rawAsPublic

type PublicData = Event.Data<typeof publicDefinition>
type PublicPayload = Event.Payload<typeof publicDefinition>
type PublicEncoded = Schema.Codec.Encoded<typeof publicDefinition>
type _DataHasNoPublication = Assert<Equal<"publication" extends keyof PublicData ? true : false, false>>
type _PayloadHasNoPublication = Assert<Equal<"publication" extends keyof PublicPayload ? true : false, false>>
type _EncodedHasNoPublication = Assert<Equal<"publication" extends keyof PublicEncoded ? true : false, false>>
type _PublicDefinitionIsDefinition = Assert<Assignable<typeof publicDefinition, Event.Definition>>
type _InternalNotPublic = Assert<Equal<Assignable<typeof internalDefinition, Event.PublicEventDefinitionV1>, false>>

void unwrap
