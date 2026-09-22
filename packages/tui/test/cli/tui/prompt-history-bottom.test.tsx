import { expect, mock, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { InputRenderable } from "@opentui/core"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"

// Keystroke-level coverage for INV-3/INV-5 (contract audit expectations §7):
// down at the exhausted prompt history hands the keystroke to the route's
// subagent list, and every other state leaves the keystroke with the editor.
// The unit level cannot reach this — the trigger lives inside the keymap
// command's run() against a focused editor — so this drives the real app,
// real keymap and a headless renderer.
//
// SKIPPED, not deleted: the harness below boots the full app and navigates
// into the session route (verified: route.current flips, /session/{id} and
// message/todo/diff are fetched), but the session view stays blank because
// the stubbed projection is not yet faithful enough for it to paint —
// finishing this needs the message/part/todo/diff response shapes the real
// server produces (seed a real data dir instead of stubbing: `opencode
// serve` on an isolated XDG_DATA_HOME, create a root via POST /session,
// then INSERT child rows into $XDG_DATA_HOME/opencode/opencode-local.db
// table `session` copying project_id/directory and setting parent_id —
// that path was verified to surface children in GET /session). Flip the
// skips once the view paints; the assertions are already written.

const session = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Session ${id}`,
  slug: id,
  projectID: "project",
  directory,
  location: { directory },
  version: "0.0.0-test",
  time: { created: 0, updated: 0 },
  ...extra,
})

const root = session("ses_root")

async function boot(input: { sessions: Record<string, unknown>[] }) {
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false, kittyKeyboard: true })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  // hey-api clients resolve `.data` to the parsed body itself, not a
  // {data: body} envelope.
  const detail = (id: string) => json(input.sessions.find((item) => item.id === id))
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json(input.sessions)
    if (url.pathname === "/session/ses_root") return detail("ses_root")
    if (url.pathname === "/session/ses_a") return detail("ses_a")
    if (url.pathname === "/session/ses_b") return detail("ses_b")
    // Session sub-resources (messages, todo, diff) are irrelevant here.
    if (url.pathname.startsWith("/session/")) return json([])
    // Without a provider the app force-opens the connect-provider dialog,
    // which swallows every keystroke before the prompt sees one.
    if (url.pathname === "/config/providers")
      return json({
        providers: [
          {
            id: "test",
            name: "Test",
            models: { "test-model": { id: "test-model", name: "Test Model", limit: { context: 200000 } } },
          },
        ],
        default: { test: "test-model" },
      })
    if (url.pathname === "/provider")
      return json({
        all: [
          {
            id: "test",
            name: "Test",
            models: { "test-model": { id: "test-model", name: "Test Model", limit: { context: 200000 } } },
          },
        ],
        default: { test: "test-model" },
        connected: ["test"],
      })
    return undefined
  }, events)
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  const { run } = await import("../../../src/app")
  const task = Effect.runPromise(
    run({
      url: "http://test",
      directory,
      config: createTuiResolvedConfig({ plugin_enabled: {} }),
      fetch: calls.fetch,
      events: events.source,
      args: {},
      pluginHost: {
        async start(pluginInput) {
          api = pluginInput.api
          started()
        },
        async dispose() {},
      },
    }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
  )

  await ready
  return {
    setup,
    api: () => api,
    /** Navigate into the session view; the continue-arg path needs more of
     * the session list projection than this stub provides. */
    async openSession() {
      api?.route.navigate("session", { sessionID: "ses_root" })
      return waitFocused(setup)
    },
    async exit() {
      api?.keymap.dispatchCommand("app.exit")
      await task
      if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    },
  }
}

type TestSetup = Awaited<ReturnType<typeof createTestRenderer>>

async function waitFocused(setup: TestSetup) {
  // The renderer goes idle once loading finishes, so waitFor's frame-driven
  // polling stalls; drive frames ourselves while polling the focus.
  for (let i = 0; i < 100; i++) {
    const editor = setup.renderer.currentFocusedEditor
    if (editor instanceof InputRenderable) return editor
    await setup.renderOnce()
    await Bun.sleep(10)
  }
  throw new Error(
    `session prompt input never took focus (focused: ${
      setup.renderer.currentFocusedEditor?.constructor?.name
    })\nframe:\n${setup.captureCharFrame()}`,
  )
}

test.skip("down at the exhausted prompt history opens the subagent list", async () => {
  const app = await boot({
    sessions: [
      root,
      session("ses_a", { parentID: "ses_root", agent: "explore", metadata: { agentName: "alpha" } }),
      session("ses_b", { parentID: "ses_root", agent: "explore", metadata: { agentName: "beta" } }),
    ],
  })

  try {
    const editor = await app.openSession()
    await app.setup.renderOnce()

    app.setup.mockInput.pressKey("ARROW_DOWN")
    const frame = await app.setup.waitForFrame((content) => content.includes("Subagents"))

    // The list carries the subagent rows; the keystroke was consumed, so the
    // editor neither moved into history nor lost its (empty) content.
    expect(frame).toContain("alpha")
    expect(frame).toContain("beta")
    expect(editor.plainText).toBe("")
  } finally {
    await app.exit()
    mock.restore()
  }
})

test.skip("down stays with the editor when the session has no subagents", async () => {
  const app = await boot({ sessions: [root] })

  try {
    const editor = await app.openSession()
    await app.setup.renderOnce()

    app.setup.mockInput.pressKey("ARROW_DOWN")
    await app.setup.renderOnce()
    await app.setup.renderOnce()

    expect(app.setup.captureCharFrame()).not.toContain("Subagents")
    expect(editor.plainText).toBe("")
  } finally {
    await app.exit()
    mock.restore()
  }
})

test.skip("down does not hijack the keystroke while the input has text", async () => {
  const app = await boot({
    sessions: [
      root,
      session("ses_a", { parentID: "ses_root", agent: "explore", metadata: { agentName: "alpha" } }),
    ],
  })

  try {
    const editor = await app.openSession()
    await app.setup.renderOnce()

    app.setup.mockInput.pressKey("x")
    await app.setup.waitFor(() => editor.plainText === "x")
    app.setup.mockInput.pressKey("ARROW_DOWN")
    await app.setup.renderOnce()
    await app.setup.renderOnce()

    expect(app.setup.captureCharFrame()).not.toContain("Subagents")
    expect(editor.plainText).toBe("x")
  } finally {
    await app.exit()
    mock.restore()
  }
})
