import { expect, test } from "bun:test"
import { FastCheck } from "effect/testing"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import {
  formatExitCodeLine,
  savedOutputPath,
  savedOutputPaths,
  summarizeToolError,
  summarizeToolText,
} from "@opencode-ai/core/session/tool-result-projection"

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toStartWith(
    "Here is the conversation so far:\n\n<conversation>\nconversation history\n</conversation>",
  )
  expect(prompt.indexOf("</conversation>")).toBeLessThan(prompt.indexOf("Create a new anchored summary"))
  expect(prompt).toContain("conversation history in the <conversation> tags above")
  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

test("compaction prompt gives update instructions for a prior summary", () => {
  const prompt = SessionCompaction.buildPrompt({
    context: ["new conversation"],
    previousSummary: "existing summary",
  })

  expect(prompt.indexOf("<conversation>")).toBeLessThan(prompt.indexOf("<prior-summary>"))
  expect(prompt.indexOf("</prior-summary>")).toBeLessThan(prompt.indexOf("The <prior-summary> summarizes"))
  expect(prompt).toContain(
    "Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary>",
  )
  expect(prompt).toContain('Move completed work from "Active" to "Completed".')
  expect(prompt).toContain('Update "Objective" and "Next Move" to reflect the current work state.')
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

test("summarizeToolText keeps results within budget byte-identical", () => {
  for (const size of [1_999, 2_000]) {
    const text = "a".repeat(size)
    expect(summarizeToolText(text)).toBe(text)
  }
})

test("summarizeToolText retains head and tail with an omission marker", () => {
  const head = "h".repeat(1_400)
  const tail = "t".repeat(600)
  const middle = "m".repeat(900)
  const text = head + middle + tail
  const summarized = summarizeToolText(text)

  expect(summarized.startsWith(head)).toBe(true)
  expect(summarized.endsWith(tail)).toBe(true)
  expect(summarized).toContain(`[... ${text.length - 2_000} chars truncated ...]`)
  expect(summarized).not.toContain(middle.slice(0, 16))
})

test("summarizeToolText keeps a trailing full-output hint inside the tail window", () => {
  const text = `${"log line\n".repeat(400)}(Results are truncated...)\nFull output saved to: /tmp/tool_x`
  const summarized = summarizeToolText(text)

  expect(summarized).toContain("Full output saved to: /tmp/tool_x")
  expect(summarized.startsWith(text.slice(0, 1_400))).toBe(true)
})

test("formatExitCodeLine renders only finite non-zero exits", () => {
  expect(formatExitCodeLine({ exit: 7 })).toBe("[exit code: 7]")
  expect(formatExitCodeLine({ exit: -1 })).toBe("[exit code: -1]")
  expect(formatExitCodeLine({ exit: 0 })).toBeUndefined()
  expect(formatExitCodeLine({ exit: -0 })).toBeUndefined()
  expect(formatExitCodeLine({ exit: Number.NaN })).toBeUndefined()
  expect(formatExitCodeLine({ exit: Number.POSITIVE_INFINITY })).toBeUndefined()
  expect(formatExitCodeLine({ exit: Number.NEGATIVE_INFINITY })).toBeUndefined()
  expect(formatExitCodeLine({ exit: null })).toBeUndefined()
  expect(formatExitCodeLine({ exit: "7" })).toBeUndefined()
  expect(formatExitCodeLine({})).toBeUndefined()
  expect(formatExitCodeLine(undefined)).toBeUndefined()
})

test("the V2 summary keeps the saved output path when attachments displace it from the tail", () => {
  FastCheck.assert(
    FastCheck.property(FastCheck.integer({ min: 0, max: 80 }), FastCheck.nat(4_000), (count, extra) => {
      const file = "/tmp/artifacts/" + "p".repeat(20 + (extra % 800))
      const footer =
        "The tool call succeeded but the output was truncated. Full output saved to: " +
        file +
        "\nUse Grep to search the full content or Read with offset/limit to view specific sections."
      const result = SessionCompaction.serializeToolContent([
        { type: "text", text: "log ".repeat(800 + extra) + "\n" + footer },
        ...Array.from({ length: count }, (_, index) => ({
          type: "file" as const,
          uri: "data:image/png;base64,AAAA",
          mime: "image/png",
          name: `image-${index}.png`,
        })),
      ])
      expect(result).toContain(file)
      expect(result.length).toBeLessThan(2200 + file.length)
      expect(result).not.toContain("base64")
    }),
    {
      seed: 60414,
      numRuns: 80,
      examples: [
        [40, 1000],
        [0, 0],
      ],
    },
  )
})

test("V2 summaries retain distinct text-block artifacts and count references beyond their allowance", () => {
  for (const count of [2, 200]) {
    const files = Array.from({ length: count }, (_, index) => "/output/" + index + "/" + "p".repeat(400))
    const blocks = files.map((file) => ({
      type: "text" as const,
      text:
        "log mentions " +
        file +
        ".bak\n" +
        "body ".repeat(400) +
        "\nThe tool call succeeded but the output was truncated. Full output saved to: " +
        file +
        "\nUse Grep to search the full content or Read with offset/limit to view specific sections.",
    }))
    const preview = SessionCompaction.serializeToolContent([
      ...blocks,
      blocks[0]!,
      { type: "text", text: "tail".repeat(500) },
    ])
    const included = files.filter((file) => (preview + "\n").includes("Full output saved to: " + file + "\n"))
    if (count === 2) expect(included).toEqual(files)
    else {
      expect(included.length).toBeGreaterThan(0)
      expect(preview).toContain(`[${count - included.length} more artifact paths in the original tool result]`)
      expect(preview.length).toBeLessThan(35_000)
    }
  }
})

test("V2 summaries preserve V2 ToolOutputStore hints, explicit outputPaths, and multiple hints in one block", () => {
  const v2Path = "/tmp/opencode/tool-output/v2-artifact.txt"
  const extraPath = "/tmp/opencode/tool-output/metadata-only.txt"
  const secondHint = "/tmp/opencode/tool-output/second-hint.txt"
  const text = [
    "head ".repeat(400),
    `... output truncated; full content saved to ${v2Path} ...`,
    `The tool call succeeded but the output was truncated. Full output saved to: ${secondHint}\r`,
    "Use Grep to search the full content or Read with offset/limit to view specific sections.\r",
    "tail ".repeat(400),
  ].join("\n")

  expect(savedOutputPaths(text)).toEqual([v2Path, secondHint])
  expect(savedOutputPath(text)).toBe(secondHint)

  const preview = SessionCompaction.serializeToolContent([{ type: "text", text }], [extraPath])
  expect(preview).toContain(`Full output saved to: ${extraPath}`)
  expect(preview).toContain(`Full output saved to: ${v2Path}`)
  expect(preview).toContain(`Full output saved to: ${secondHint}`)
})

test("summarizeToolError preserves the trailing saved-output hint even when earlier text quotes another hint", () => {
  const quoted = "/tmp/quoted-earlier.txt"
  const real = "/tmp/real-error-artifact.txt"
  const error =
    `The tool call succeeded but the output was truncated. Full output saved to: ${quoted}\n` +
    "Use Grep to search the full content or Read with offset/limit to view specific sections.\n" +
    "x".repeat(3_000) +
    `\nThe tool call failed; error output was truncated. Full output saved to: ${real}\r\n` +
    "Use Grep to search the full content or Read with offset/limit to view specific sections.\r\n" +
    "trailing context ".repeat(80)
  const summarized = summarizeToolError(error)
  expect(summarized).toEndWith(`\nFull output saved to: ${real}`)
})

test("PBT: V2 serializeToolContent preserves all distinct V1/V2/outputPaths artifacts across random blocks and attachments", () => {
  const hintKind = FastCheck.constantFrom("none" as const, "v1-ok" as const, "v1-err" as const, "v2" as const)
  const formatHint = (kind: "none" | "v1-ok" | "v1-err" | "v2", file: string, crlf: boolean) => {
    const nl = crlf ? "\r\n" : "\n"
    if (kind === "none") return ""
    if (kind === "v2") return `... output truncated; full content saved to ${file} ...`
    const lead =
      kind === "v1-err"
        ? "The tool call failed; error output was truncated."
        : "The tool call succeeded but the output was truncated."
    return `${lead} Full output saved to: ${file}${nl}Use Grep to search the full content or Read with offset/limit to view specific sections.`
  }

  FastCheck.assert(
    FastCheck.property(
      FastCheck.array(
        FastCheck.record({
          headLen: FastCheck.integer({ min: 0, max: 1_800 }),
          tailLen: FastCheck.integer({ min: 0, max: 1_800 }),
          kind1: hintKind,
          kind2: hintKind,
          crlf: FastCheck.boolean(),
        }),
        { minLength: 1, maxLength: 4 },
      ),
      FastCheck.integer({ min: 0, max: 3 }),
      FastCheck.integer({ min: 0, max: 20 }),
      (specs, extraPathCount, attachmentCount) => {
        const expectedPaths: string[] = []
        const seen = new Set<string>()
        const record = (p: string) => {
          if (seen.has(p)) return
          seen.add(p)
          expectedPaths.push(p)
        }
        const outputPaths = Array.from({ length: extraPathCount }, (_, i) => `/tmp/v2/out-${i}.txt`)
        for (const p of outputPaths) record(p)

        const blocks = specs.map((spec, idx) => {
          const p1 = `/tmp/v2/b${idx}-first.txt`
          const p2 = `/tmp/v2/b${idx}-second.txt`
          if (spec.kind1 !== "none") record(p1)
          if (spec.kind2 !== "none") record(p2)
          const nl = spec.crlf ? "\r\n" : "\n"
          const text = [
            "a".repeat(spec.headLen),
            formatHint(spec.kind1, p1, spec.crlf),
            formatHint(spec.kind2, p2, spec.crlf),
            "b".repeat(spec.tailLen),
          ]
            .filter(Boolean)
            .join(nl)
          return { type: "text" as const, text }
        })
        const attachments = Array.from({ length: attachmentCount }, (_, i) => ({
          type: "file" as const,
          uri: "data:image/png;base64,AAAA",
          mime: "image/png",
          name: `att-${i}.png`,
        }))

        const result = SessionCompaction.serializeToolContent([...blocks, ...attachments], outputPaths)
        for (const file of expectedPaths) {
          expect(result).toContain(file)
        }
        expect(result).not.toContain("base64")
      },
    ),
    { seed: 600803, numRuns: 200 },
  )
})

test("PBT: summarizeToolError always retains the trailing real artifact path regardless of earlier quoted hints", () => {
  FastCheck.assert(
    FastCheck.property(
      FastCheck.integer({ min: 0, max: 400 }),
      FastCheck.integer({ min: 1_500, max: 4_000 }),
      FastCheck.integer({ min: 700, max: 1_500 }),
      FastCheck.boolean(),
      FastCheck.boolean(),
      (prefixLen, midLen, postLen, quotedIsV2, crlf) => {
        const nl = crlf ? "\r\n" : "\n"
        const quoted = "/tmp/quoted/earlier.txt"
        const real = "/tmp/real/trailing-error.txt"
        const quotedHint = quotedIsV2
          ? `... output truncated; full content saved to ${quoted} ...`
          : `The tool call succeeded but the output was truncated. Full output saved to: ${quoted}${nl}Use Grep to search the full content or Read with offset/limit to view specific sections.`
        const realHint = `The tool call failed; error output was truncated. Full output saved to: ${real}${nl}Use Grep to search the full content or Read with offset/limit to view specific sections.`
        const full = ["p".repeat(prefixLen), quotedHint, "m".repeat(midLen), realHint, "z".repeat(postLen)].join(nl)
        const summarized = summarizeToolError(full)
        expect(summarized).toContain(`Full output saved to: ${real}`)
      },
    ),
    { seed: 600804, numRuns: 200 },
  )
})
