import { describe, expect, it } from "bun:test"
import { compareVersion, parseVersion, type ForkVersion } from "../../src/installation/version-compare"

const v = (text: string) => {
  const parsed = parseVersion(text)
  if (!parsed) throw new Error(`fixture not parseable: ${text}`)
  return parsed
}

describe("parseVersion", () => {
  const accept = (text: string, expected: Partial<ForkVersion>) => {
    const parsed = parseVersion(text)
    expect(parsed).toBeDefined()
    expect(parsed).toMatchObject(expected)
  }

  it("parses stable with ordinal", () => {
    accept("v1.18.31-fmv2.1", {
      baseline: { major: 1, minor: 18, patch: 31 },
      generation: 2,
      ordinal: 1,
      channel: "stable",
      betaNumber: 0,
    })
  })

  it("parses stable without ordinal (defaults 0)", () => {
    accept("1.18.31-fmv3", { generation: 3, ordinal: 0, channel: "stable" })
  })

  it("parses beta", () => {
    accept("v1.18.31-fmv3-beta.17", { generation: 3, ordinal: 0, channel: "beta", betaNumber: 17 })
  })

  it("parses beta on an ordinal", () => {
    accept("1.18.31-fmv2.2-beta.1", { generation: 2, ordinal: 2, channel: "beta", betaNumber: 1 })
  })

  it("rejects non-fork versions", () => {
    expect(parseVersion("1.18.31")).toBeUndefined()
    expect(parseVersion("1.18.31-beta.1")).toBeUndefined()
  })

  it("rejects pr-build suffixes", () => {
    expect(parseVersion("1.18.31-fmv3-pr59.2")).toBeUndefined()
  })

  it("rejects leading zeros on M and k (fork-release grammar)", () => {
    expect(parseVersion("1.18.31-fmv02")).toBeUndefined()
    expect(parseVersion("1.18.31-fmv2.01")).toBeUndefined()
    expect(parseVersion("1.18.31-fmv2-beta.02")).toBeUndefined()
  })

  it("rejects trailing garbage", () => {
    expect(parseVersion("1.18.31-fmv2.1-x86")).toBeUndefined()
  })

  it("rejects empty and garbage input", () => {
    expect(parseVersion("")).toBeUndefined()
    expect(parseVersion("local")).toBeUndefined()
  })
})

describe("compareVersion", () => {
  it("orders the issue's semver counterexamples correctly", () => {
    expect(compareVersion(v("1.18.31-fmv2.2"), v("1.18.31-fmv2.2-beta.1"))).toBe(1)
    expect(compareVersion(v("1.18.31-fmv10"), v("1.18.31-fmv9"))).toBe(1)
  })

  it("orders ordinals", () => {
    expect(compareVersion(v("1.18.31-fmv2.1"), v("1.18.31-fmv2"))).toBe(1)
    expect(compareVersion(v("1.18.31-fmv2.10"), v("1.18.31-fmv2.9"))).toBe(1)
  })

  it("orders beta numbers within the same ordinal", () => {
    expect(compareVersion(v("1.18.31-fmv2.1-beta.4"), v("1.18.31-fmv2.1-beta.3"))).toBe(1)
  })

  it("orders across baselines", () => {
    expect(compareVersion(v("1.19.0-fmv1"), v("1.18.31-fmv9"))).toBe(1)
    expect(compareVersion(v("1.18.32-fmv1"), v("1.18.31-fmv9"))).toBe(1)
  })

  it("treats identical versions as equal", () => {
    expect(compareVersion(v("v1.18.31-fmv2.1"), v("1.18.31-fmv2.1"))).toBe(0)
  })

  // Deterministic pseudo-random sweep: total-order properties over 2000 pairs.
  const seed = 0x666d // "fm"
  let state = seed
  const next = (n: number) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state % n
  }
  const randVersion = (): ForkVersion => ({
    baseline: { major: next(3), minor: next(4), patch: next(5) },
    generation: next(4),
    ordinal: next(3),
    channel: next(2) === 0 ? "stable" : "beta",
    betaNumber: 0,
  })

  it("satisfies total-order properties under a random sweep", () => {
    // betaNumber is constrained by the channel invariant; build consistent versions.
    const consistent = (x: ForkVersion): ForkVersion => ({
      ...x,
      betaNumber: x.channel === "beta" ? 1 + next(3) : 0,
    })
    const samples = Array.from({ length: 100 }, () => consistent(randVersion()))

    for (let i = 0; i < 2000; i++) {
      const a = samples[next(samples.length)]
      const b = samples[next(samples.length)]
      const c = samples[next(samples.length)]
      const ab = compareVersion(a, b)
      const ba = compareVersion(b, a)
      const bc = compareVersion(b, c)
      const ca = compareVersion(c, a)

      // antisymmetry (Object.is: -0 !== 0 under toBe)
      expect(ab === -ba || (ab === 0 && ba === 0)).toBe(true)
      // transitivity
      if (ab === 1 && bc === 1) expect(ca).toBe(-1)
      if (ab === 0) expect(ba).toBe(0)
      // totality
      expect([-1, 0, 1]).toContain(ab)
      // stability outranks beta number at equal prefix
      if (a.channel === "stable" && b.channel === "beta") {
        const prefix = compareVersion({ ...a, channel: "beta", betaNumber: 0 }, b)
        if (prefix === 0) expect(ab).toBe(1)
      }
    }
  })
})
