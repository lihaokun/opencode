import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { formatAgentRow, type SubagentListMember } from "../routes/session/index"

const ROW_CAP = 5

/**
 * The persistent Agents panel below the input (verification finding P4): the
 * same row anatomy as the down dialog — Main, blurbs, status, current marker,
 * live token/elapsed meters — always on screen, each row click-to-jump. The
 * down dialog stays the keyboard/filter surface; this one is glanceability.
 *
 * Hidden by the route when the tree has a single member (a lone Main row is
 * noise). More than ROW_CAP rows truncate with a tail pointing at the dialog
 * rather than trap rows inside an unfocused scroll region.
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
    props.members.map((member) => ({
      id: member.id,
      ...formatAgentRow({
        member,
        isRoot: member.id === props.rootID,
        isCurrent: member.id === props.currentID,
        info: sync.session.get(member.id),
        statusType: sync.data.session_status[member.id]?.type,
        now: now(),
      }),
    })),
  )
  const visible = createMemo(() => rows().slice(0, ROW_CAP))
  const overflow = createMemo(() => rows().length - visible().length)

  return (
    <box flexShrink={0} paddingLeft={2} paddingRight={2}>
      <For each={visible()}>
        {(row) => (
          <box
            flexDirection="row"
            justifyContent="space-between"
            onMouseOver={() => setHover(row.id)}
            onMouseOut={() => setHover(undefined)}
            onMouseUp={() => props.onPick(row.id)}
            backgroundColor={hover() === row.id ? theme.backgroundElement : theme.backgroundPanel}
          >
            <text fg={theme.text} overflow="hidden" wrapMode="none">
              {row.title}
              <Show when={row.description}>
                <span style={{ fg: theme.textMuted }}> {row.description}</span>
              </Show>
            </text>
            <Show when={row.footer} fallback={<box width={0} />}>
              <text flexShrink={0} fg={theme.textMuted}>
                {row.footer}
              </text>
            </Show>
          </box>
        )}
      </For>
      <Show when={overflow() > 0}>
        <box backgroundColor={theme.backgroundPanel}>
          <text fg={theme.textMuted}>+{overflow()} more — down opens the list</text>
        </box>
      </Show>
    </box>
  )
}
