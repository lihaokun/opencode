import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { SplitBorder } from "../ui/border"
import { contextUsage, formatAgentRow, type SubagentListMember } from "../routes/session/index"

const ROW_CAP = 5

/**
 * The persistent Agents panel below the input (verification finding P4): the
 * same row anatomy as the down dialog — Main, blurbs, status, live
 * token/elapsed meters — always on screen, each row click-to-jump. The down
 * dialog stays the keyboard/filter surface; this one is glanceability.
 *
 * Frame mirrors the input box (left border + inner padding 2/2), so the
 * panel's edges coincide with the input's (P5-1). The current session is
 * highlighted with a dot and the primary title color; the dot lives in a
 * fixed-width gutter that every row reserves, so marking it never shifts the
 * labels (P5-2).
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
    <box flexShrink={0} border={["left"]} borderColor={theme.border} customBorderChars={SplitBorder.customBorderChars}>
      <box paddingLeft={2} paddingRight={2}>
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
              <text flexShrink={0} fg={row.isCurrent ? theme.primary : theme.textMuted}>
                {row.isCurrent ? "● " : "  "}
                {row.indent}
              </text>
              <text fg={row.isCurrent ? theme.primary : theme.text} overflow="hidden" wrapMode="none">
                {row.label}
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
          <text fg={theme.textMuted}>+{overflow()} more — down opens the list</text>
        </Show>
      </box>
    </box>
  )
}
