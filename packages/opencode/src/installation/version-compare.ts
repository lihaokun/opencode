// Fork release version grammar and comparison.
//
// A fork release tag is `v?<baseline>-fmv<N>[.<M>][-beta.<k>]` where baseline
// is an upstream semver and N/M/k follow the fork-release validation regex
// (fork-release.yml:82): baseline segments accept `[0-9]+` (leading zeros
// allowed there too), M and k accept `(0|[1-9][0-9]*)` — no leading zeros.
// This module mirrors that grammar exactly and compares versions with a
// lexicographic total order over (baseline, generation, ordinal, stability,
// beta number) — semver's own ordering is wrong for this scheme (it ranks
// 1.18.31-fmv9 above 1.18.31-fmv10 and fmv2.2-beta.1 above fmv2.2).

const BASELINE = String.raw`[0-9]+\.[0-9]+\.[0-9]+`
// Mirrors fork-release.yml:82 — M/k take no leading zero.
const NUM = String.raw`(?:0|[1-9][0-9]*)`
const FORK_TAG = new RegExp(
  String.raw`^(${BASELINE})-fmv(${NUM})(?:\.(${NUM}))?(?:-beta\.(${NUM}))?$`,
)

export interface ForkVersion {
  baseline: { major: number; minor: number; patch: number }
  generation: number
  ordinal: number
  channel: "stable" | "beta"
  betaNumber: number
}

export function parseVersion(text: string): ForkVersion | undefined {
  const match = FORK_TAG.exec(text.replace(/^v/, ""))
  if (!match) return undefined
  // Groups: 1 = whole baseline, 2..4 = baseline segments, 5 = N, 6 = M, 7 = k.
  const baseline = match[1].split(".").map(Number)
  const generation = Number(match[2])
  const ordinal = match[3] ? Number(match[3]) : 0
  const betaNumber = match[4] ? Number(match[4]) : 0
  return {
    baseline: { major: baseline[0], minor: baseline[1], patch: baseline[2] },
    generation,
    ordinal,
    channel: betaNumber > 0 ? "beta" : "stable",
    betaNumber,
  }
}

const cmp = (a: number, b: number): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0)

export function compareVersion(a: ForkVersion, b: ForkVersion): -1 | 0 | 1 {
  const levels: number[][] = [
    [a.baseline.major, b.baseline.major],
    [a.baseline.minor, b.baseline.minor],
    [a.baseline.patch, b.baseline.patch],
    [a.generation, b.generation],
    [a.ordinal, b.ordinal],
    // Stability outranks the beta number: 1.18.31-fmv2.2 > 1.18.31-fmv2.2-beta.9.
    [a.channel === "beta" ? 0 : 1, b.channel === "beta" ? 0 : 1],
    [a.betaNumber, b.betaNumber],
  ]
  for (const [x, y] of levels) {
    const order = cmp(x, y)
    if (order !== 0) return order
  }
  return 0
}
