/** @jsxImportSource @opentui/solid */
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { expect, test } from "bun:test"
import { onMount, type ParentProps } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { TestTuiContexts } from "../../fixture/tui-environment"
import * as SyncModule from "../../../src/context/sync"
import * as SdkModule from "../../../src/context/sdk"
import * as RouteModule from "../../../src/context/route"
import * as DialogModule from "../../../src/ui/dialog"
import * as ThemeModule from "../../../src/context/theme"
import * as ToastModule from "../../../src/ui/toast"
import * as DialogMessageModule from "../../../src/routes/session/dialog-message"
import * as KvModule from "../../../src/context/kv"
import * as ConfigModule from "../../../src/config"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import type { Message } from "@opencode-ai/sdk/v2"

// Issue #69: the Message Actions menu must not put the destructive action
// first, and choosing Revert must confirm before reverting. Rendered with the
// real DialogSelect/DialogConfirm over a stubbed sync store; the revert call
// goes through the real SDK client against a stub fetch, so the component's
// actual call path is what gets asserted.

type Store = ReturnType<typeof SyncModule.useSync>

const userMessage = (overrides: Partial<Message> = {}): Message =>
  ({
    id: "msg_1",
    sessionID: "ses_1",
    role: "user",
    agent: "build",
    model: { providerID: "test", modelID: "test-model" },
    time: { created: Date.now() },
    ...overrides,
  }) as Message

async function mountDialogMessage(input: { messages: Message[]; openMessageID?: string }) {
  const revertCalls: string[] = []
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  function Opener(props2: { messageID: string }) {
    onMount(() => {
      DialogModule.useDialog().replace(() => (
        <DialogMessageModule.DialogMessage messageID={props2.messageID} sessionID="ses_1" />
      ))
    })
    return null
  }

  function WithKeymap(props2: ParentProps) {
    const renderer = useRenderer()
    const resolvedConfig = createTuiResolvedConfig({ plugin_enabled: {} })
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onMount(() => off)
    return <OpencodeKeymapProvider keymap={keymap}>{props2.children}</OpencodeKeymapProvider>
  }

  function Harness() {
    const syncStub = {
      data: {
        message: { ses_1: input.messages },
        part: {},
      },
    } as unknown as Store

    // The real SDK client over a stub fetch: session.revert goes out as POST
    // /session/{id}/revert, recorded here.
    const stubFetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname.endsWith("/revert")) {
        revertCalls.push(url.pathname)
      }
      return new Response(JSON.stringify({}), { headers: { "content-type": "application/json" } })
    }) as typeof fetch

    return (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <WithKeymap>
          <RouteModule.RouteProvider initialRoute={{ type: "session", sessionID: "ses_1" }}>
            <ConfigModule.TuiConfigProvider config={createTuiResolvedConfig({ plugin_enabled: {} })}>
              <KvModule.KVProvider>
                <ThemeModule.ThemeProvider mode="dark">
                  <ToastModule.ToastProvider>
                    <SdkModule.SDKProvider url="http://test" fetch={stubFetch}>
                      <SyncModule.SyncContext.Provider value={syncStub}>
                        <DialogModule.DialogProvider>
                          <Opener messageID={input.openMessageID ?? input.messages[0]!.id} />
                          <box width={80} height={20} />
                        </DialogModule.DialogProvider>
                      </SyncModule.SyncContext.Provider>
                    </SdkModule.SDKProvider>
                  </ToastModule.ToastProvider>
                </ThemeModule.ThemeProvider>
              </KvModule.KVProvider>
            </ConfigModule.TuiConfigProvider>
          </RouteModule.RouteProvider>
        </WithKeymap>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: 30 })
  return { app, revertCalls }
}

async function wait(app: { captureCharFrame(): string }, fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) {
      throw new Error(`timed out. frame:\n${app.captureCharFrame()}`)
    }
    await Bun.sleep(10)
  }
}

/** Open the menu, move to Revert (third item), submit. */
async function chooseRevert(app: Awaited<ReturnType<typeof mountDialogMessage>>["app"]) {
  await wait(app, () => app.captureCharFrame().includes("Message Actions"))
  app.mockInput.pressKey("ARROW_DOWN")
  await Bun.sleep(30)
  app.mockInput.pressKey("ARROW_DOWN")
  await Bun.sleep(30)
  app.mockInput.pressEnter()
}

test("menu lists Copy first, not Revert", async () => {
  const mounted = await mountDialogMessage({ messages: [userMessage()] })
  const { app } = mounted

  try {
    await wait(app, () => app.captureCharFrame().includes("Message Actions"))
    const frame = app.captureCharFrame()
    const copyAt = frame.indexOf("Copy")
    const forkAt = frame.indexOf("Fork")
    const revertAt = frame.indexOf("Revert")
    expect(copyAt).toBeGreaterThan(-1)
    expect(forkAt).toBeGreaterThan(copyAt)
    expect(revertAt).toBeGreaterThan(forkAt)
  } finally {
    app.renderer.destroy()
  }
})

test("choosing Revert opens a confirm dialog and only reverts after confirm", async () => {
  const mounted = await mountDialogMessage({
    messages: [userMessage(), userMessage({ id: "msg_2" }), userMessage({ id: "msg_3" })],
  })
  const { app, revertCalls } = mounted

  try {
    await chooseRevert(app)
    await wait(app, () => app.captureCharFrame().includes("Confirm Revert"))
    expect(revertCalls).toEqual([])
    app.mockInput.pressEnter()
    await wait(app, () => revertCalls.length === 1)
    expect(revertCalls[0]).toContain("/session/ses_1/revert")
  } finally {
    app.renderer.destroy()
  }
})

test("canceling the confirm dialog leaves the session untouched", async () => {
  const mounted = await mountDialogMessage({
    messages: [userMessage(), userMessage({ id: "msg_2" })],
  })
  const { app, revertCalls } = mounted

  try {
    await chooseRevert(app)
    await wait(app, () => app.captureCharFrame().includes("Confirm Revert"))
    // Move to Cancel, then press return: nothing is reverted.
    app.mockInput.pressKey("ARROW_LEFT")
    await Bun.sleep(30)
    app.mockInput.pressEnter()
    await Bun.sleep(100)
    expect(revertCalls).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("confirm copy names the count and the undo key", async () => {
  const mounted = await mountDialogMessage({
    messages: [userMessage(), userMessage({ id: "msg_2" }), userMessage({ id: "msg_3" })],
  })
  const { app } = mounted

  try {
    await chooseRevert(app)
    await wait(app, () => app.captureCharFrame().includes("Confirm Revert"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("3 messages (starting with this one)")
    expect(frame).toContain("<leader>r")
  } finally {
    app.renderer.destroy()
  }
})

test("single-message session counts the message itself, not zero", async () => {
  // Review of PR #88: the server deletes the selected message too (the
  // revert boundary lands on it), so a one-message session must say
  // "1 message (starting with this one)" — not "0 messages after this one".
  const mounted = await mountDialogMessage({ messages: [userMessage()] })
  const { app } = mounted

  try {
    await chooseRevert(app)
    await wait(app, () => app.captureCharFrame().includes("Confirm Revert"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("1 message (starting with this one)")
    expect(frame).not.toContain("0 messages")
  } finally {
    app.renderer.destroy()
  }
})

test("interleaved turns count assistants from the selected message on", async () => {
  // Review of PR #88: the deletion set includes assistants after the
  // boundary, so user/assistant/user/assistant from the selection = 4.
  const mounted = await mountDialogMessage({
    messages: [
      userMessage(),
      userMessage({ id: "msg_2" }),
      userMessage({ id: "msg_3" }),
      userMessage({ id: "msg_4" }),
    ],
    openMessageID: "msg_2",
  })
  const { app } = mounted

  try {
    await chooseRevert(app)
    await wait(app, () => app.captureCharFrame().includes("Confirm Revert"))
    // Selected msg_2 (index 1 of 4): msgs 2..4 are removed.
    const frame = app.captureCharFrame()
    expect(frame).toContain("3 messages (starting with this one)")
  } finally {
    app.renderer.destroy()
  }
})

test("stale messages add the snapshot warning to the confirm copy", async () => {
  const eightDays = Date.now() - 8 * 24 * 60 * 60 * 1000
  const mounted = await mountDialogMessage({
    messages: [userMessage({ time: { created: eightDays } }), userMessage({ id: "msg_2" })],
  })
  const { app } = mounted

  try {
    await chooseRevert(app)
    await wait(app, () => app.captureCharFrame().includes("Confirm Revert"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("older than 7 days")
  } finally {
    app.renderer.destroy()
  }
})
