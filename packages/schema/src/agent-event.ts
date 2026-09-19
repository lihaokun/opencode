export * as AgentEvent from "./agent-event"

import { Schema } from "effect"
import { Event } from "./event"
import { SessionID } from "./session-id"

/**
 * The lifetime of one asynchronous delegation, as something a client can watch.
 *
 * A delegation's result does not appear where it was started. The subagent
 * finishes, its job settles, a watcher writes the result into the caller's
 * session, and the caller wakes for another turn. Between the subagent going
 * idle and the caller going busy, every session is idle and nothing is running —
 * a client reading the event stream sees a finished tree that is not finished.
 *
 * Nothing else in the stream distinguishes that from a tree that really is done:
 * a cancelled subagent goes idle the same way and no result ever follows. Only
 * the delegation knows, so it says so.
 *
 * `started` is published when the delegation is registered; `settled` once its
 * result has been delivered to the caller, or once it is certain none will be.
 * A client that keeps the difference knows whether waiting is still warranted,
 * rather than guessing at how long a handoff ought to take.
 *
 * Published only for delegations that report back on their own. A caller that
 * waits on the result itself never leaves the gap this describes, and a pair of
 * events for it would be a debt nothing ever settles.
 */
export const Delegation = Event.define({
  type: "agent.delegation",
  schema: {
    /** The subagent's own session. */
    sessionID: SessionID,
    /** The session that started it, and the one its result is owed to. */
    caller: SessionID,
    status: Schema.Literals(["started", "settled"]),
  },
})

export const Definitions = Event.inventory(Delegation)
