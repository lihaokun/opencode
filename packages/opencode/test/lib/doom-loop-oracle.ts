// Reference definition of the in-step repeat check (fix docs
// session-processor-fix-periodic-doom-loop §3 and
// session-fix-step-tail-repeat-and-agents §3.1): the last 3p signatures form
// three equal blocks for some period p in [1, maxPeriod].
export type Call = {
  tool: string
  input: Record<string, unknown>
}

export function oracle(sequence: readonly Call[], maxPeriod: number) {
  const signatures = sequence.map((call) => JSON.stringify([call.tool, call.input]))
  for (let period = 1; period <= maxPeriod; period++) {
    if (signatures.length < 3 * period) continue
    const start = signatures.length - 3 * period
    let same = true
    for (let offset = 0; offset < period; offset++) {
      const first = signatures[start + offset]
      if (first !== signatures[start + period + offset] || first !== signatures[start + 2 * period + offset]) {
        same = false
        break
      }
    }
    if (same) return true
  }
  return false
}
