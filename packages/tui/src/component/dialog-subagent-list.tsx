import { createMemo } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useSync } from "../context/sync"
import { Locale } from "../util/locale"
import type { SubagentListMember } from "../routes/session/index"

/**
 * The subagent list opened from the session view (Step P10). Rows are display
 * only — membership and order come from subagentListMembers (routes/session,
 * tested without rendering); this component reads the live projection for
 * each row's label and status.
 *
 * Row label resolves like the roster does: instance name, then the agent
 * type, then the title's "@type subagent" suffix, then a bare placeholder.
 */
export function DialogSubagentList(props: { members: SubagentListMember[]; onPick: (sessionID: string) => void }) {
  const dialog = useDialog()
  const sync = useSync()

  const options = createMemo(() =>
    props.members.map((member) => {
      const info = sync.session.get(member.id)
      const name = typeof info?.metadata?.agentName === "string" ? info.metadata.agentName : undefined
      const type = info?.agent
      const fromTitle = info?.title.match(/@(\w+) subagent/)?.[1]
      const label = name ?? type ?? (fromTitle ? Locale.titlecase(fromTitle) : "Subagent")
      const status = sync.data.session_status[member.id]?.type
      return {
        title: `${"  ".repeat(member.depth)}${label}`,
        description: [type, status].filter(Boolean).join(" · ") || undefined,
        value: member.id,
      }
    }),
  )

  return (
    <DialogSelect
      title="Subagents"
      placeholder="Filter subagents"
      options={options()}
      onSelect={(option) => {
        if (typeof option.value === "string") props.onPick(option.value)
        dialog.clear()
      }}
    />
  )
}
