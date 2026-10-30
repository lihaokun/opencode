import { describe, expect, test } from "bun:test"
import { confirmExit, EXIT_CONFIRM_WINDOW_MS } from "../../src/util/confirm-exit"

const fresh = { count: 0, firstAt: undefined as number | undefined }

describe("confirmExit", () => {
  test("first press arms the guard without exiting", () => {
    const { decision, next } = confirmExit(fresh, 1000)
    expect(decision).toBe("count")
    expect(next).toEqual({ count: 1, firstAt: 1000 })
  })

  test("second press inside the window exits and resets", () => {
    const armed = { count: 1, firstAt: 1000 }
    const { decision, next } = confirmExit(armed, 1000 + EXIT_CONFIRM_WINDOW_MS - 1)
    expect(decision).toBe("exit")
    expect(next).toEqual({ count: 0, firstAt: undefined })
  })

  test("second press exactly at the window boundary resets instead of exiting", () => {
    const armed = { count: 1, firstAt: 1000 }
    const { decision, next } = confirmExit(armed, 1000 + EXIT_CONFIRM_WINDOW_MS)
    expect(decision).toBe("count")
    expect(next).toEqual({ count: 1, firstAt: 1000 + EXIT_CONFIRM_WINDOW_MS })
  })

  test("second press after the window rearms from one", () => {
    const armed = { count: 1, firstAt: 1000 }
    const { decision, next } = confirmExit(armed, 1000 + EXIT_CONFIRM_WINDOW_MS + 1)
    expect(decision).toBe("count")
    expect(next).toEqual({ count: 1, firstAt: 1000 + EXIT_CONFIRM_WINDOW_MS + 1 })
  })

  test("a stale sequence from before an exit does not exit on the next press", () => {
    // After an exit the state resets; the next press must count, not exit.
    const { decision } = confirmExit(fresh, 1000)
    expect(decision).toBe("count")
  })
})
