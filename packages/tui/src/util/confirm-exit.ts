/** Two-press exit confirmation state machine, shared by the app.exit command
 * run and its tests. The first press arms the guard and reports a hint; a
 * second press inside the window exits; the window expiring (or an exit in
 * between) rearms from zero. `now` is injected so tests don't sleep. */
export type ExitConfirmState = {
  count: number
  firstAt: number | undefined
}

export const EXIT_CONFIRM_WINDOW_MS = 5000
const EXIT_CONFIRM_THRESHOLD = 2

export type ExitConfirmDecision = "count" | "exit" | "reset"

export function confirmExit(state: ExitConfirmState, now: number, windowMs = EXIT_CONFIRM_WINDOW_MS): {
  decision: ExitConfirmDecision
  next: ExitConfirmState
} {
  const withinWindow = state.firstAt !== undefined && now - state.firstAt < windowMs
  if (!withinWindow) {
    // First press of a fresh sequence (or a stale one left over from before
    // the window closed): arm the guard, do not exit.
    return { decision: "count", next: { count: 1, firstAt: now } }
  }
  const count = state.count + 1
  if (count >= EXIT_CONFIRM_THRESHOLD) {
    return { decision: "exit", next: { count: 0, firstAt: undefined } }
  }
  return { decision: "count", next: { count, firstAt: state.firstAt } }
}
