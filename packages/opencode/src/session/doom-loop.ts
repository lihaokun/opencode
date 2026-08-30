export * as DoomLoop from "./doom-loop"

export const MAX_PERIOD = 10

export interface Detector {
  readonly check: (tool: string, input: Record<string, unknown>) => boolean
}

export function create(maxPeriod = MAX_PERIOD): Detector {
  const capacity = 2 * maxPeriod + 1
  const signatures = Array.from({ length: capacity }, () => "")
  const streaks = Array.from({ length: maxPeriod + 1 }, () => 0)
  let next = 0
  let size = 0

  function latest(offset: number) {
    return signatures[(next - 1 - offset + capacity) % capacity]
  }

  return {
    check(tool, input) {
      const signature = JSON.stringify([tool, input])
      signatures[next] = signature
      next = (next + 1) % capacity
      size = Math.min(size + 1, capacity)

      let detected = false
      for (let period = 1; period <= maxPeriod; period++) {
        const same = size > 2 * period && latest(0) === latest(period) && latest(0) === latest(2 * period)
        streaks[period] = same ? Math.min(streaks[period] + 1, period) : 0
        if (streaks[period] === period) detected = true
      }
      return detected
    },
  }
}
