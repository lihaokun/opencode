import { expect, test } from "bun:test"
import { FastCheck } from "effect/testing"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"

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

import { formatExitCodeLine, summarizeToolText } from "@opencode-ai/core/session/tool-result-projection"

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
  expect(formatExitCodeLine({ exit: 0 })).toBeUndefined()
  expect(formatExitCodeLine({ exit: null })).toBeUndefined()
  expect(formatExitCodeLine({ exit: "7" })).toBeUndefined()
  expect(formatExitCodeLine({})).toBeUndefined()
  expect(formatExitCodeLine(undefined)).toBeUndefined()
})

test("the V2 summary keeps the saved output path when attachments displace it from the tail", () => {
  FastCheck.assert(
    FastCheck.property(FastCheck.integer({ min: 0, max: 80 }), FastCheck.nat(4_000), (count, extra) => {
      const file = "/tmp/artifacts/" + "p".repeat(20 + extra % 800)
      const footer = "The tool call succeeded but the output was truncated. Full output saved to: " + file +
        "\nUse Grep to search the full content or Read with offset/limit to view specific sections."
      const result = SessionCompaction.serializeToolContent([
        { type: "text", text: "log ".repeat(800 + extra) + "\n" + footer },
        ...Array.from({ length: count }, (_, index) => ({
          type: "file" as const, uri: "data:image/png;base64,AAAA", mime: "image/png", name: `image-${index}.png`,
        })),
      ])
      expect(result).toContain(file)
      expect(result.length).toBeLessThan(2200 + file.length)
      expect(result).not.toContain("base64")
    }),
    { seed: 60414, numRuns: 80, examples: [[40, 1000], [0, 0]] },
  )
})

test("V2 summaries retain distinct text-block artifacts and count references beyond their allowance", () => {
  for (const count of [2, 200]) {
    const files = Array.from({ length: count }, (_, index) => "/output/" + index + "/" + "p".repeat(400))
    const blocks = files.map((file) => ({
      type: "text" as const,
      text: "body ".repeat(400) + "\nThe tool call succeeded but the output was truncated. Full output saved to: " + file +
        "\nUse Grep to search the full content or Read with offset/limit to view specific sections.",
    }))
    const preview = SessionCompaction.serializeToolContent([...blocks, blocks[0]!, { type: "text", text: "tail".repeat(500) }])
    const included = files.filter((file) => preview.includes(file))
    if (count === 2) expect(included).toEqual(files)
    else {
      expect(included.length).toBeGreaterThan(0)
      expect(preview).toContain(`[${count - included.length} more artifact paths in the original tool result]`)
      expect(preview.length).toBeLessThan(35_000)
    }
  }
})
