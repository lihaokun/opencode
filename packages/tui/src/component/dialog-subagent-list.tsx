import { createMemo, createSignal, onCleanup } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useSync } from "../context/sync"
import { agentListRows, formatAgentRow } from "../routes/session/index"

/** A just-finished subagent stays listed this long before folding into its parent's "N finished" row. */
export const RECENT_MS = 45_000

/**
 * The dialog's options from the live projection — pure, so the filter path is
 * testable without rendering. DialogSelect filters only the options it is
 * given, so while a query is typed every agent is listed and nothing folds;
 * otherwise an agent inside a fold could not be found by its title. Clearing
 * the query brings the folds back as they were: typing never touches `open`.
 */
export function agentListOptions(input: {
  sessions: Parameters<typeof agentListRows>[0]["sessions"]
  rootID: string
  currentID: string
  running: (id: string) => boolean
  now: number
  open: ReadonlySet<string>
  query: string
  info: (id: string) => Parameters<typeof formatAgentRow>[0]["info"]
  messages: (id: string) => Parameters<typeof formatAgentRow>[0]["messages"]
  statusType: (id: string) => Parameters<typeof formatAgentRow>[0]["statusType"]
}) {
  const rows = agentListRows({
    sessions: input.sessions,
    rootID: input.rootID,
    running: input.running,
    pinned: input.currentID,
    now: input.now,
    recentMs: RECENT_MS,
    open: input.open,
    fold: input.query.length === 0,
  })
  return rows.map((row) => {
    // pl 0 and no dot: scrollbox(1) + Option's internal 3 puts the titles on
    // the Filter "F" column and the meters on the esc-tail column; the tree
    // indent travels inside the title, and the primary title marks current.
    if (row.kind === "bucket") {
      const mark = input.open.has(row.parentID) ? "▾" : "▸"
      return {
        title: `${"  ".repeat(row.depth)}${mark} ${row.count} finished`,
        value: `fold:${row.parentID}`,
        dot: false,
        pl: 0,
      }
    }
    const formatted = formatAgentRow({
      member: { id: row.id, depth: row.depth },
      isRoot: row.id === input.rootID,
      info: input.info(row.id),
      messages: input.messages(row.id),
      statusType: input.statusType(row.id),
      now: input.now,
    })
    return { title: formatted.indent + formatted.label, footer: formatted.footer, value: row.id, dot: false, pl: 0 }
  })
}

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
  const [query, setQuery] = createSignal("")

  const options = createMemo(() =>
    agentListOptions({
      sessions: sync.data.session,
      rootID: props.rootID,
      currentID: props.currentID,
      running: (id) => {
        const type = sync.data.session_status[id]?.type
        return type === "busy" || type === "retry"
      },
      now: now(),
      open: open(),
      query: query(),
      info: (id) => sync.session.get(id),
      messages: (id) => sync.data.message[id] ?? [],
      statusType: (id) => sync.data.session_status[id]?.type,
    }),
  )

  return (
    <DialogSelect
      title="Agents"
      placeholder="Filter agents"
      options={options()}
      current={props.currentID}
      preserveSelection={true}
      onFilter={setQuery}
      onSelect={(option) => {
        if (typeof option.value !== "string") return
        // A fold toggles in place; the dialog stays open.
        if (option.value.startsWith("fold:")) {
          const parent = option.value.slice("fold:".length)
          setOpen((prev) => {
            const next = new Set(prev)
            if (!next.delete(parent)) next.add(parent)
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
