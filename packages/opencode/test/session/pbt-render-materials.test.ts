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

  const materialArb: fc.Arbitrary<RestorationMaterial> = fc.record({
    candidate: fc.record({
      kind: fc.constant("file"),
      ref: fc.string({ minLength: 1, maxLength: 20 }).map((s) => `/f/${s.replace(/[^\w.-]/g, "x")}`),
      lastUseSeq: fc.nat(100),
    }),
    status: fc.constantFrom("inlined", "reference", "skipped-duplicate", "skipped-budget", "missing"),
    content: fc.option(fc.string({ minLength: 1, maxLength: 400 }).filter((s) => s.trim().length > 0), {
      nil: undefined,
    }),
  }) as fc.Arbitrary<RestorationMaterial>

  it("inlined file count and total budget stay within limits, and rendering is idempotent", () => {
    fc.assert(
      fc.property(fc.array(materialArb, { maxLength: 20 }), (materials) => {
        const text = renderMaterials(materials, cfg)
        if (!text) return materials.every((m) => m.status !== "inlined")
        // Count occurrences, not membership: duplicate refs share one heading
        // string, so a single includes() would over-count them.
        const countHeadings = (ref: string) => text.split(`### ${ref}\n`).length - 1
        const inlinedFiles = materials.filter(
          (m) =>
            m.status === "inlined" &&
            m.candidate.kind === "file" &&
            countHeadings(m.candidate.ref) > 0,
        )
        const totalHeadings = new Set(
          inlinedFiles.map((m) => m.candidate.ref),
        )
        for (const ref of totalHeadings) {
          expect(countHeadings(ref)).toBeLessThanOrEqual(cfg.max_files)
        }
        let used = 0
        for (const m of inlinedFiles) {
          used += Token.estimate(m.content ?? "")
        }
        expect(used).toBeLessThanOrEqual(cfg.budget_tokens)
        expect(text).toContain(RESTORATION_SENTINEL)
        // Idempotent: the same input renders to the same output.
        expect(renderMaterials(materials, cfg)).toBe(text)
        return true
      }),
      { seed: 0x2_026_10_18, numRuns: 300 },
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
})
