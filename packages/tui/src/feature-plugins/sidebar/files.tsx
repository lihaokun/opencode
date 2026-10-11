import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { MouseEvent } from "@opentui/core"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show, createSignal } from "solid-js"
import { Locale } from "../../util/locale"

const id = "internal:sidebar-files"

/** Rows the expanded list shows at once; the rest scroll under the wheel. */
export const FILE_ROWS = 5

/**
 * The window the expanded list shows: `offset` clamped so the window never
 * runs past the end (the list can shrink underneath it), the rows inside it,
 * and how many rows lie above and below — the fsm-status sidebar's ledger.
 */
export function fileWindow<T>(files: readonly T[], offset: number, rows = FILE_ROWS) {
  const top = Math.max(0, Math.min(offset, files.length - rows))
  return {
    top,
    shown: files.slice(top, top + rows),
    above: top,
    below: Math.max(0, files.length - top - rows),
  }
}

/** Additions and deletions summed over the list, for the one-line header. */
export function fileTotals(files: readonly { additions: number; deletions: number }[]) {
  return files.reduce(
    (acc, item) => ({ additions: acc.additions + item.additions, deletions: acc.deletions + item.deletions }),
    { additions: 0, deletions: 0 },
  )
}

function changeCountWidth(item: { additions: number; deletions: number }) {
  return [item.additions ? `+${item.additions}` : "", item.deletions ? `-${item.deletions}` : ""]
    .filter(Boolean)
    .join(" ").length
}

/**
 * One line by default — `▶ Modified Files (N)` with the summed +/- at the
 * right — because the list is the session's whole history of touched files
 * and only its size is worth a glance. Expanding opens a FILE_ROWS window
 * that the wheel scrolls, with `↑ N more` / `↓ N more` lines that page on
 * click; the diff viewer is where the changes themselves are read.
 */
function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(false)
  const [offset, setOffset] = createSignal(0)
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.session.diff(props.session_id))
  const totals = createMemo(() => fileTotals(list()))
  const window = createMemo(() => fileWindow(list(), offset()))
  const scroll = (delta: number) => setOffset(fileWindow(list(), window().top + delta).top)

  return (
    <Show when={list().length > 0}>
      <box>
        <box flexDirection="row" gap={1} justifyContent="space-between" onMouseDown={() => setOpen((x) => !x)}>
          <box flexDirection="row" gap={1}>
            <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
            <text fg={theme().text}>
              <b>Modified Files</b>
            </text>
            <text fg={theme().textMuted}>({list().length})</text>
          </box>
          <box flexDirection="row" gap={1} flexShrink={0}>
            <Show when={totals().additions}>
              <text fg={theme().diffAdded}>+{totals().additions}</text>
            </Show>
            <Show when={totals().deletions}>
              <text fg={theme().diffRemoved}>-{totals().deletions}</text>
            </Show>
          </box>
        </box>
        <Show when={open()}>
          <box
            onMouseScroll={(event: MouseEvent) => {
              const direction = event.scroll?.direction
              if (direction !== "up" && direction !== "down") return
              scroll(direction === "up" ? -1 : 1)
            }}
          >
            <Show when={window().above > 0}>
              <text fg={theme().textMuted} onMouseUp={() => scroll(-FILE_ROWS)}>
                ↑ {window().above} more
              </text>
            </Show>
            <For each={window().shown}>
              {(item) => (
                <box flexDirection="row" gap={1} justifyContent="space-between">
                  <text fg={theme().textMuted} wrapMode="none">
                    {Locale.truncateLeft(item.file, Math.max(2, 36 - changeCountWidth(item)))}
                  </text>
                  <box flexDirection="row" gap={1} flexShrink={0}>
                    <Show when={item.additions}>
                      <text fg={theme().diffAdded}>+{item.additions}</text>
                    </Show>
                    <Show when={item.deletions}>
                      <text fg={theme().diffRemoved}>-{item.deletions}</text>
                    </Show>
                  </box>
                </box>
              )}
            </For>
            <Show when={window().below > 0}>
              <text fg={theme().textMuted} onMouseUp={() => scroll(FILE_ROWS)}>
                ↓ {window().below} more
              </text>
            </Show>
          </box>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 500,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
