import { createMemo, createSignal, onCleanup } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useSync } from "../context/sync"
import { contextUsage, formatAgentRow, type SubagentListMember } from "../routes/session/index"

/**
 * The Agents list opened from the session view (Step P10). Rows are display
 * only — membership and order come from subagentListMembers (routes/session,
 * tested without rendering); this component reads the live projection for
 * each row's label, blurb and meters.
 *
 * Row anatomy (verification finding P3): label — work blurb — then, at the
 * far right, live token spend and elapsed time (ticking while the agent
 * runs, frozen to its work duration once done). The tree's root renders as
 * "Main" — it is not a subagent, it is where the Main row goes back to. The
 * session being viewed is preselected via DialogSelect's `current` and
 * tagged "current" in its description, so the same list reads correctly
 * from any seat in the tree.
 */
export function DialogSubagentList(props: {
  members: SubagentListMember[]
  rootID: string
  currentID: string
  onPick: (sessionID: string) => void
}) {
  const dialog = useDialog()
  const sync = useSync()
  // One tick per second keeps the elapsed column live while the dialog is
  // open; the interval dies with the component.
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))

  const options = createMemo(() =>
    props.members.map((member) => {
      const info = sync.session.get(member.id)
      const row = formatAgentRow({
          member,
          isRoot: member.id === props.rootID,
          info,
          usage: contextUsage({
            messages: sync.data.message[member.id] ?? [],
            providers: sync.data.provider,
          }),
          statusType: sync.data.session_status[member.id]?.type,
          now: now(),
      })
      // The dot lives in the gutter with the indent, so marking the current
      // row never shifts its label relative to the other rows.
      return {
        title: row.label,
        description: row.description,
        footer: row.footer,
        gutter: () => <text>{(member.id === props.currentID ? "● " : "  ") + row.indent}</text>,
        value: member.id,
      }
    }),
  )

  return (
    <DialogSelect
      title="Agents"
      placeholder="Filter agents"
      options={options()}
      current={props.currentID}
      onSelect={(option) => {
        if (typeof option.value === "string") props.onPick(option.value)
        dialog.clear()
      }}
    />
  )
}
