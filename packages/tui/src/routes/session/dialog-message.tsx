import { createMemo } from "solid-js"
import { useSync } from "../../context/sync"
import { DialogSelect } from "../../ui/dialog-select"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useClipboard } from "../../context/clipboard"
import { DialogConfirm } from "../../ui/dialog-confirm"
import type { DialogContext } from "../../ui/dialog"
import type { PromptInfo } from "../../component/prompt/history"
import { stripPromptPartIDs as strip } from "../../prompt/part"

/** Snapshot diffs are pruned after 7 days (Snapshot.prune), so reverting an
 * older message may not be able to restore file changes. The confirm dialog
 * says so instead of failing silently. */
const SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export function revertConfirmMessage(input: { reverted: number; stale: boolean }) {
  const base =
    input.reverted === 1
      ? "This will remove 1 message (starting with this one) and restore the file changes made in it."
      : `This will remove ${input.reverted} messages (starting with this one) and restore the file changes made in them.`
  const recover = "You can restore with <leader>r (or /redo) before sending a new message."
  const staleLine = input.stale
    ? " This message is older than 7 days: its snapshot may have been pruned, and file changes may not be restorable."
    : ""
  return `${base} ${recover}.${staleLine}`
}

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const sync = useSync()
  const sdk = useSDK()
  const message = createMemo(() => sync.data.message[props.sessionID]?.find((x) => x.id === props.messageID))
  const route = useRoute()
  const clipboard = useClipboard()

  // Server-side deletion set: the revert boundary lands on this message (it
  // is a user message — the timeline and the message row only offer user
  // messages), and cleanup removes it and everything after it, assistants
  // included. The count must match what actually gets deleted.
  const revertedCount = createMemo(() => {
    const all = sync.data.message[props.sessionID] ?? []
    const index = all.findIndex((x) => x.id === props.messageID)
    if (index === -1) return 0
    return all.length - index
  })

  const revert = async (dialog: DialogContext) => {
    const msg = message()
    if (!msg) return

    void sdk.client.session.revert({
      sessionID: props.sessionID,
      messageID: msg.id,
    })

    if (props.setPrompt) {
      const parts = sync.data.part[msg.id]
      const promptInfo = parts.reduce(
        (agg, part) => {
          if (part.type === "text") {
            if (!part.synthetic) agg.input += part.text
          }
          if (part.type === "file") agg.parts.push(strip(part))
          return agg
        },
        { input: "", parts: [] as PromptInfo["parts"] },
      )
      props.setPrompt(promptInfo)
    }

    dialog.clear()
  }

  return (
    <DialogSelect
      title="Message Actions"
      options={[
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async (dialog) => {
            const msg = message()
            if (!msg) return

            const parts = sync.data.part[msg.id]
            const text = parts.reduce((agg, part) => {
              if (part.type === "text" && !part.synthetic) {
                agg += part.text
              }
              return agg
            }, "")

            await clipboard.write?.(text)
            dialog.clear()
          },
        },
        {
          title: "Fork",
          value: "session.fork",
          description: "create a new session",
          onSelect: async (dialog) => {
            const result = await sdk.client.session.fork({
              sessionID: props.sessionID,
              messageID: props.messageID,
            })
            const msg = message()
            const prompt = msg
              ? sync.data.part[msg.id].reduce(
                  (agg, part) => {
                    if (part.type === "text") {
                      if (!part.synthetic) agg.input += part.text
                    }
                    if (part.type === "file") agg.parts.push(part)
                    return agg
                  },
                  { input: "", parts: [] as PromptInfo["parts"] },
                )
              : undefined
            route.navigate({
              sessionID: result.data!.id,
              type: "session",
              prompt,
            })
            dialog.clear()
          },
        },
        {
          title: "Revert",
          value: "session.revert",
          description: "undo messages and file changes",
          onSelect: (dialog) => {
            const msg = message()
            if (!msg) return
            const stale = msg.time.created < Date.now() - SNAPSHOT_RETENTION_MS
            void DialogConfirm.show(dialog, "Confirm Revert", revertConfirmMessage({ reverted: revertedCount(), stale })).then(
              (confirmed) => {
                if (!confirmed) return
                void revert(dialog)
              },
            )
          },
        },
      ]}
    />
  )
}
