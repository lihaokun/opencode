import fc from "fast-check"
import { describe, expect, it } from "bun:test"
import {
  RESTORATION_SENTINEL,
  renderMaterials,
  restorationConfig,
  type RestorationMaterial,
} from "../../src/session/restoration"
import { Token } from "../../src/util/token"

/**
 * §5.3 第三层随机测试（C11 第三组）：任意材料序列下，注入文本的 inlined
 * 文件数不超 max_files、总注入 token 量不超 budget_tokens；同一输入重复
 * 渲染结果相同（幂等）。
 */
describe("PBT renderMaterials", () => {
  const cfg = { ...restorationConfig(undefined), max_files: 3, budget_tokens: 50 }

  // Inlined materials always carry content in production (materialize only
  // stamps inlined on a successful read); tie the generator to that shape so
  // the property tests render logic, not impossible inputs.
  const refArb = fc.string({ minLength: 1, maxLength: 20 }).map((s) => `/f/${s.replace(/[^\w.-]/g, "x")}`)
  const contentArb = fc.string({ minLength: 1, maxLength: 400 }).filter((s) => s.trim().length > 0)
  const candidateArb = fc.record({
    kind: fc.constantFrom("file", "skill", "todo"),
    ref: refArb,
    lastUseSeq: fc.nat(100),
  })
  const materialArb: fc.Arbitrary<RestorationMaterial> = fc
    .record({
      candidate: candidateArb,
      status: fc.constantFrom("inlined", "reference", "skipped-duplicate", "skipped-budget", "missing"),
      content: fc.option(contentArb, { nil: undefined }),
    })
    .map((m) => (m.status === "inlined" ? { ...m, content: m.content ?? "fallback-body" } : m)) as fc.Arbitrary<RestorationMaterial>

  it("the final rendered block honors max_files and budget on the OUTPUT itself", () => {
    fc.assert(
      fc.property(fc.array(materialArb, { maxLength: 20 }), (materials) => {
        const text = renderMaterials(materials, cfg)
        if (!text) return materials.every((m) => m.status !== "inlined")
        // Oracle over the final text, not the inputs: count FILE headings —
        // inside the "## Files" section only, so a skill/todo heading that
        // happens to reuse a /f/ ref is not miscounted — and the total must
        // obey max_files (the old per-ref oracle could not catch many refs
        // blowing past it).
        const filesSection = text.slice(text.indexOf("## Files"), text.indexOf("## Skills") === -1 ? undefined : text.indexOf("## Skills"))
        const fileHeadings = (filesSection.match(/^### /gm) ?? []).length
        expect(fileHeadings).toBeLessThanOrEqual(cfg.max_files)
        // The whole block — headings, fences, reference lines, overflow
        // summary — stays within budget plus the fixed framing allowance
        // (sentinel + section titles + the capped not-restored list).
        expect(Token.estimate(text)).toBeLessThanOrEqual(cfg.budget_tokens + 200)
        expect(text).toContain(RESTORATION_SENTINEL)
        // Idempotent: the same input renders to the same output.
        expect(renderMaterials(materials, cfg)).toBe(text)
        return true
      }),
      { seed: 0x2_026_10_18, numRuns: 300 },
    )
  })

  it("zero budget renders no inlined bodies", () => {
    fc.assert(
      fc.property(fc.array(materialArb, { maxLength: 20 }), (materials) => {
        const tight = { ...cfg, budget_tokens: 0 }
        const text = renderMaterials(materials, tight)
        if (!text) return true
        // Nothing is inlined: no fenced content sections at all.
        expect(text).not.toMatch(/^### \/f\//gm)
        return true
      }),
      { seed: 0x2_026_10_18, numRuns: 100 },
    )
  })

  it("anchors: budget exhaustion degrades and the sentinel is present", () => {
    const text = renderMaterials(
      [
        {
          candidate: { kind: "file", ref: "/f/a", lastUseSeq: 1 },
          status: "inlined",
          content: "x".repeat(300),
        },
        {
          candidate: { kind: "file", ref: "/f/b", lastUseSeq: 2 },
          status: "inlined",
          content: "y".repeat(300),
        },
      ],
      cfg,
    )!
    expect(text).toContain(RESTORATION_SENTINEL)
    expect(text).toContain("/f/b (skipped: restoration budget exhausted")
  })

  // Self-audit P3-a: MAX_REFERENCE_LINES caps line COUNT only; refs are raw
  // absolute paths (PATH_MAX 4096) and reasons carry guidance prose, so the
  // count cap alone admits ~21k tokens against the default 8000 budget. The
  // generator must therefore NOT assume short refs — pathological paths are
  // exactly the input this property exists for.
  it("pathological refs cannot blow the budget through reference lines", () => {
    const pathological = restorationConfig(undefined) // budget 8000
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            candidate: fc.record({
              kind: fc.constantFrom("file", "skill", "todo"),
              // PATH_MAX-scale refs, not the friendly /f/x shapes.
              ref: fc.string({ minLength: 1, maxLength: 4096 }).map((s) => `/${s.replace(/\n/g, "x")}`),
              lastUseSeq: fc.nat(100),
            }),
            status: fc.constantFrom("reference", "missing"),
            reason: fc.option(fc.string({ maxLength: 200 }), { nil: undefined }),
          }),
          { maxLength: 60 },
        ),
        (materials) => {
          const text = renderMaterials(materials as RestorationMaterial[], pathological)
          if (!text) return true
          // 20 reference lines × (clipped ref + reason) + framing stays a small
          // multiple of the budget — unclipped PATH_MAX refs would blow past it.
          expect(Token.estimate(text)).toBeLessThan(pathological.budget_tokens + 2_000)
          return true
        },
      ),
      { seed: 0x2_026_10_18, numRuns: 200 },
    )
    // Deterministic worst case — the PBT generator can under-sample long
    // strings, so anchor the exact adversarial shape: a full set of
    // PATH_MAX-length refs at the line cap. Unclipped: 20 × 4 KiB ≈ 21k
    // tokens against the 8000 budget.
    const worstCase = Array.from({ length: 40 }, (_, n) => ({
      candidate: { kind: "file" as const, ref: `/deep/${"d".repeat(4090)}${n}`, lastUseSeq: n },
      status: "missing" as const,
      reason: "file not found on disk",
    }))
    const text = renderMaterials(worstCase, pathological)!
    expect(Token.estimate(text)).toBeLessThan(pathological.budget_tokens + 2_000)
  })
})

it("bounds the complete diagnostic when both its reference and its reason name a missing file", () => {
  const cfg = restorationConfig(undefined)
  fc.assert(
    fc.property(fc.integer({ min: 2600, max: 3960 }), fc.integer({ min: 20, max: 40 }), (pathChars, count) => {
      const materials = Array.from({ length: count }, (_, index) => {
        const ref = `/missing/${"segment/".repeat(Math.ceil(pathChars / 8))}${index}.md`
        return {
          candidate: { kind: "file" as const, ref, lastUseSeq: count - index },
          status: "missing" as const,
          reason: `file not found on disk: ${ref}`,
        }
      })
      const text = renderMaterials(materials, cfg)
      expect(text).toContain("## Not restored")
      // The existing PATH_MAX invariant allows at most 2,000 tokens of framing
      // beyond the configured payload budget for the default configuration.
      expect(Token.estimate(text!)).toBeLessThan(cfg.budget_tokens + 2_000)
    }),
    { seed: 0x5560, numRuns: 50 },
  )
})

it("charges each inline heading and fence for arbitrarily small skill bodies", () => {
  const check = (budget: number, count: number, body: string, width: number) => {
    const materials = Array.from({ length: count }, (_, i) => ({
      candidate: { kind: "skill" as const, ref: `skill-${i}-${"s".repeat(width)}`, lastUseSeq: i },
      status: "inlined" as const,
      content: body,
    }))
    const text = renderMaterials(materials, { ...restorationConfig(undefined), budget_tokens: budget })!
    const inline = text.split("\n## Not restored")[0]!
    if (inline.includes("### ")) expect(Token.estimate(inline)).toBeLessThanOrEqual(budget)
    expect(Token.estimate(text)).toBeLessThanOrEqual(budget + Math.max(128, Math.min(2000, budget)))
  }
  check(100, 1000, "x", 20)
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 500 }),
      fc.integer({ min: 25, max: 200 }),
      fc.constantFrom("", "x", "xx", "abcd", "😀"),
      fc.integer({ min: 1, max: 160 }),
      check,
    ),
    { seed: 60021, numRuns: 100 },
  )
})
