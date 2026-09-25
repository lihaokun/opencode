import { createMemo, Show } from "solid-js"
import { useRouteData } from "../../context/route"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { SplitBorder } from "../../ui/border"
import { Locale } from "../../util/locale"
import { contextUsage } from "./index"
import { useTerminalDimensions } from "@opentui/solid"

// Informational only since verification finding P1: navigation lives in the
// Agents list (down at the exhausted prompt history), so the Parent/Prev/Next
// shortcuts and their keybindings are gone. What remains is where you are and
// what it cost.
export function SubagentFooter() {
  const route = useRouteData("session")
  const sync = useSync()
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const session = createMemo(() => sync.session.get(route.sessionID))

  const subagentInfo = createMemo(() => {
    const s = session()
    if (!s) return { label: "Subagent", index: 0, total: 0 }
    const agentMatch = s.title.match(/@(\w+) subagent/)
    const label = agentMatch ? Locale.titlecase(agentMatch[1]) : "Subagent"

    if (!s.parentID) return { label, index: 0, total: 0 }

    const siblings = sync.data.session
      .filter((x) => x.parentID === s.parentID)
      .toSorted((a, b) => a.time.created - b.time.created)
    const index = siblings.findIndex((x) => x.id === s.id)

    return { label, index: index + 1, total: siblings.length }
  })

  const usage = createMemo(() => {
    // The shared context-usage readout (P5-4): one convention across the
    // footer, the Agents dialog and the persistent panel.
    const readout = contextUsage({ messages: messages(), providers: sync.data.provider })
    if (!readout) return

    const cost = session()?.cost ?? 0
    const money = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    })

    return {
      context: `${Locale.number(readout.tokens)}${readout.pct ? ` (${readout.pct})` : ""}`,
      cost: cost > 0 ? money.format(cost) : undefined,
    }
  })

  const { theme } = useTheme()
  useTerminalDimensions()

  return (
    <box flexShrink={0}>
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        {...SplitBorder}
        border={["left"]}
        borderColor={theme.border}
        flexShrink={0}
        backgroundColor={theme.backgroundPanel}
      >
        <box flexDirection="row" gap={1}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.text}>
              <b>{subagentInfo().label}</b>
            </text>
            <Show when={subagentInfo().total > 0}>
              <text style={{ fg: theme.textMuted }}>
                ({subagentInfo().index} of {subagentInfo().total})
              </text>
            </Show>
            <Show when={usage()}>
              {(item) => (
                <text fg={theme.textMuted} wrapMode="none">
                  {[item().context, item().cost].filter(Boolean).join(" · ")}
                </text>
              )}
            </Show>
          </box>
        </box>
      </box>
    </box>
  )
}
