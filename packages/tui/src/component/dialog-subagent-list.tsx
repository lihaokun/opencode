import { createMemo, createSignal, onCleanup } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useSync } from "../context/sync"
import { agentListRows, formatAgentRow } from "../routes/session/index"

/** A just-finished subagent stays listed this long before folding into its parent's "N finished" row. */
const RECENT_MS = 45_000

/**
 * The Agents list opened by down at the end of the prompt history. One line
 * per agent — title at the left, `status · elapsed · tokens` at the right —
 * in tree order under the root ("Main"); finished subtrees fold into a
 * "N finished" row that selecting expands. Rows come from agentListRows and
 * formatAgentRow (routes/session, tested without rendering); this component
 * only reads the live projection and hands picks back.
 */
export function DialogSubagentList(props: { rootID: string; currentID: string; onPick: (sessionID: string) => void }) {
  const dialog = useDialog()
  const sync = useSync()
  // One tick per second keeps the elapsed column live while the dialog is
  // open; the interval dies with the component.
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set())

  const running = (id: string) => {
    const type = sync.data.session_status[id]?.type
    return type === "busy" || type === "retry"
  }
  const rows = createMemo(() =>
    agentListRows({
      sessions: sync.data.session,
      rootID: props.rootID,
      running,
      now: now(),
      recentMs: RECENT_MS,
      open: open(),
    }),
  )
  const options = createMemo(() =>
    rows().map((row) => {
      // pl 0 and no dot: scrollbox(1) + Option's internal 3 puts the titles on
      // the Filter "F" column and the meters on the esc-tail column; the tree
      // indent travels inside the title, and the primary title marks current.
      if (row.kind === "bucket") {
        return { title: `${"  ".repeat(row.depth)}${row.count} finished`, value: `fold:${row.parentID}`, dot: false, pl: 0 }
      }
      const formatted = formatAgentRow({
        member: { id: row.id, depth: row.depth },
        isRoot: row.id === props.rootID,
        info: sync.session.get(row.id),
        messages: sync.data.message[row.id] ?? [],
        statusType: sync.data.session_status[row.id]?.type,
        now: now(),
      })
      return { title: formatted.indent + formatted.label, footer: formatted.footer, value: row.id, dot: false, pl: 0 }
    }),
  )

  return (
    <DialogSelect
      title="Agents"
      placeholder="Filter agents"
      options={options()}
      current={props.currentID}
      onSelect={(option) => {
        if (typeof option.value !== "string") return
        // A fold toggles in place; the dialog stays open.
        if (option.value.startsWith("fold:")) {
          const parent = option.value.slice("fold:".length)
          setOpen((prev) => {
            const next = new Set(prev)
            if (next.has(parent)) next.delete(parent)
            else next.add(parent)
            return next
          })
          return
        }
        props.onPick(option.value)
        dialog.clear()
      }}
    />
  )
}
