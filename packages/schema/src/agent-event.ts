export * as AgentEvent from "./agent-event"

import { Schema } from "effect"
import { Event } from "./event"
import { SessionID } from "./session-id"

/**
 * The lifetime of one asynchronous delegation, as something a client can watch.
 *
 * A delegation's result does not appear where it was started. The subagent's
 * run ends, the run itself writes the result into the parent's session, and the
 * parent wakes for another turn. Between the subagent going idle and the parent
 * going busy, every session is idle and nothing is running — a client reading
 * the event stream sees a finished tree that is not finished.
 *
 * Nothing else in the stream distinguishes that from a tree that really is done:
 * a cancelled subagent goes idle the same way and no result ever follows. Only
 * the delegation knows, so it says so.
 *
 * `started` is published when the delegation is registered; `settled` each time
 * one of the subagent's runs has reported to the parent, or once it is certain
 * that run will not. A subagent reports whenever it stops with no agent of its
 * own still running, so `settled` may follow one `started` more than once; the
 * first closes the debt. A client
 * that keeps the difference knows whether waiting is still warranted, rather
 * than guessing at how long a handoff ought to take.
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
