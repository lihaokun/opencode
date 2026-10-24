export * as SessionV2 from "./session"

import { Schema } from "effect"

export { ContextSnapshotDecodeError, MessageDecodeError } from "./session/error"

import { SessionSchema } from "./session/schema"

export const ID = SessionSchema.ID
export type ID = typeof ID.Type

export const Info = SessionSchema.Info
export type Info = typeof Info.Type

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Session.NotFoundError", {
  sessionID: Schema.String,
}) {}
