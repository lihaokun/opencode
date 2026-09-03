import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk/v2"
import {
  isTimelineReady,
  loadOlderTimeline,
  selectProjectedMessages,
  selectUserMessages,
  selectVisibleUserMessages,
} from "./model"

const user = (id: string, created = Number(id.slice(4))) => ({ id, role: "user", time: { created } }) as UserMessage
const assistant = (id: string, created = Number(id.slice(4))) =>
  ({ id, role: "assistant", time: { created } }) as AssistantMessage

describe("timeline model", () => {
  test("selects users and applies an exact timestamp-less revert boundary by array position", () => {
    const messages: Message[] = [user("msg_z", 100), assistant("msg_a", 150), user("msg_b", 200), user("msg_c", 300)]
    const users = selectUserMessages(messages)

    expect(users.map((message) => message.id)).toEqual(["msg_z", "msg_b", "msg_c"])
    expect(selectVisibleUserMessages(users, { messageID: "msg_b" }).map((message) => message.id)).toEqual(["msg_z"])
    expect(selectVisibleUserMessages(users)).toBe(users)
  })

  test("falls back to raw IDs when a timestamp-less revert boundary is missing", () => {
    const users = [user("msg_a", 100), user("msg_c", 200)]

    expect(selectVisibleUserMessages(users, { messageID: "msg_b" }).map((message) => message.id)).toEqual(["msg_a"])
  })

  test("applies a persisted revert boundary across the ID rollover", () => {
    const users = [user("msg_ffff", 100), user("msg_0001", 200), user("msg_0002", 300)]

    expect(
      selectVisibleUserMessages(users, { messageID: "msg_0001", messageTimeCreated: 200 }).map((message) => message.id),
    ).toEqual(["msg_ffff"])
  })

  test("selects the earliest hidden projection boundary by chronology", () => {
    const u1 = user("msg_fffe", 100)
    const u2 = user("msg_ffff", 200)
    const u3 = user("msg_0001", 300)
    const rawIDOrder = [u3, u1, u2]

    expect(
      selectProjectedMessages(rawIDOrder, rawIDOrder, [u1], {
        messageID: u2.id,
        messageTimeCreated: u2.time.created,
      }).map((message) => message.id),
    ).toEqual([u1.id])
  })

  test("waits for an assistant-only load to hydrate its user root", () => {
    expect(isTimelineReady([assistant("msg_2")], true)).toBe(false)
    expect(isTimelineReady([user("msg_1"), assistant("msg_2")], true)).toBe(true)
    expect(isTimelineReady([], false)).toBe(true)
  })

  test("loads exactly one opaque cursor page", async () => {
    let calls = 0
    const anchors: Array<string | boolean> = []

    await loadOlderTimeline({
      sessionID: () => "ses_test",
      more: () => true,
      loading: () => false,
      loadMore: async () => {
        calls += 1
      },
      before: () => anchors.push("before"),
      after: (done) => anchors.push("after", done),
    })

    expect(calls).toBe(1)
    expect(anchors).toEqual(["before", "after", true])
  })

  test("stops when a page adds no raw messages", async () => {
    let calls = 0
    await loadOlderTimeline({
      sessionID: () => "ses_test",
      more: () => true,
      loading: () => false,
      loadMore: async () => {
        calls += 1
      },
    })

    expect(calls).toBe(1)
  })

  test("does not restore an anchor after the session changes", async () => {
    let sessionID = "ses_old"
    let restore = 0

    await loadOlderTimeline({
      sessionID: () => sessionID,
      more: () => true,
      loading: () => false,
      loadMore: async () => {
        sessionID = "ses_new"
      },
      after: () => {
        restore += 1
      },
    })

    expect(restore).toBe(0)
  })

  test("releases the anchor when loading history fails", async () => {
    let restore = 0

    await expect(
      loadOlderTimeline({
        sessionID: () => "ses_test",
        more: () => true,
        loading: () => false,
        loadMore: async () => {
          throw new Error("history failed")
        },
        after: () => {
          restore += 1
        },
      }),
    ).rejects.toThrow("history failed")

    expect(restore).toBe(1)
  })
})
