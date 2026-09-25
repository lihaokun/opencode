import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import { RGBA } from "@opentui/core"
import { Option } from "../ui/dialog-select"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { contextUsage, formatAgentRow, type SubagentListMember } from "../routes/session/index"

const ROW_CAP = 5

/**
 * The persistent Agents panel below the input (verification finding P4): the
 * same rows as the down dialog — because they ARE the down dialog's rows.
 * After two rounds of hand-rolled layout drifting out of alignment, the panel
 * now renders the dialog's own Option component inside the dialog's exact row
 * container (conditional padding 1/3, gap 1, paddingRight 3), inside the same
 * scrollbox padding (1/1) — so its indentation is the dialog's, by
 * construction. Rows carry the indent and the current dot in a gutter; each
 * row click-to-jump; meters tick once per second. The down dialog stays the
 * keyboard/filter surface. More than ROW_CAP rows truncate with a tail
 * pointing at it rather than trap rows in an unfocused scroll region.
 */
export function AgentsPanel(props: {
  members: SubagentListMember[]
  rootID: string
  currentID: string
  onPick: (sessionID: string) => void
}) {
  const sync = useSync()
  const { theme } = useTheme()
  const [now, setNow] = createSignal(Date.now())
  const [hover, setHover] = createSignal<string | undefined>()
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))

  const rows = createMemo(() =>
    props.members.map((member) => {
      const row = formatAgentRow({
        member,
        isRoot: member.id === props.rootID,
        info: sync.session.get(member.id),
        usage: contextUsage({
          messages: sync.data.message[member.id] ?? [],
          providers: sync.data.provider,
        }),
        statusType: sync.data.session_status[member.id]?.type,
        now: now(),
      })
      return {
        id: member.id,
        isCurrent: member.id === props.currentID,
        ...row,
      }
    }),
  )
  const visible = createMemo(() => rows().slice(0, ROW_CAP))
  const overflow = createMemo(() => rows().length - visible().length)

  return (
    <box flexShrink={0}>
      <box paddingLeft={1} paddingRight={1}>
        <For each={visible()}>
          {(row) => (
            <box
              flexDirection="column"
              onMouseOver={() => setHover(row.id)}
              onMouseOut={() => setHover(undefined)}
              onMouseUp={() => props.onPick(row.id)}
            >
              <box
                flexDirection="row"
                paddingLeft={1}
                paddingRight={3}
                gap={1}
                backgroundColor={hover() === row.id ? theme.backgroundElement : RGBA.fromInts(0, 0, 0, 0)}
              >
                <Option
                  title={row.label}
                  description={row.description}
                  footer={row.footer}
                  current={row.isCurrent}
                  gutter={() => <text>{(row.isCurrent ? "● " : "  ") + row.indent}</text>}
                />
              </box>
            </box>
          )}
        </For>
        <Show when={overflow() > 0}>
          <box paddingLeft={3} paddingRight={3}>
            <text fg={theme.textMuted}>+{overflow()} more — down opens the list</text>
          </box>
        </Show>
      </box>
    </box>
  )
}
