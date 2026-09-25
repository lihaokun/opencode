/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { DialogSelect } from "../../../src/ui/dialog-select"
import { DialogProvider } from "../../../src/ui/dialog"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { KVProvider } from "../../../src/context/kv"
import { ToastProvider } from "../../../src/ui/toast"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"

// P6 alignment, measured not guessed: the Agents dialog's row labels must
// start on the same column as the "F" of the Filter placeholder, and the row
// meters must end on one shared right edge (the esc hint's column). Rendering
// the real DialogSelect and reading captured frames is the only way to see
// those columns.

async function mountAgentsDialog() {
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({})
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)

    return (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={resolvedConfig}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                  <DialogSelect
                title="Agents"
                placeholder="Filter agents"
                current="ses_a"
                options={[
                  {
                    title: "   Main",
                    description: "build · idle",
                    footer: "1.0K (12%) · 1m 0s",
                    value: "ses_root",
                    dot: false,
                    pl: 0,
                  },
                  {
                    title: "   alpha",
                    description: "explore · busy",
                    footer: "2.0K (20%) · 2m 0s",
                    value: "ses_a",
                    dot: false,
                    pl: 0,
                  },
                ]}
                onSelect={() => {}}
              />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  return testRender(() => <Harness />, { width: 80, height: 20, kittyKeyboard: true })
}

function columnsOf(frame: string, needle: string): number[] {
  return frame
    .split("\n")
    .map((line) => line.indexOf(needle))
    .filter((index) => index >= 0)
}

test("Agents dialog: row labels align with the Filter F; meters share one right edge", async () => {
  const app = await mountAgentsDialog()
  try {
    await app.renderOnce()
    await Bun.sleep(50)
    await app.renderOnce()
    const frame = app.captureCharFrame()
    const filterCols = columnsOf(frame, "Filter agents")
    expect(filterCols.length).toBeGreaterThan(0)
    const alphaCols = columnsOf(frame, "alpha")
    expect(alphaCols.length).toBeGreaterThan(0)
    const footerEnds = frame
      .split("\n")
      .map((line) => {
        const index = line.indexOf("2m 0s")
        return index >= 0 ? index + "2m 0s".length : -1
      })
      .filter((index) => index >= 0)
    expect(new Set(alphaCols)).toEqual(new Set(filterCols))
    expect(new Set(footerEnds).size).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})
