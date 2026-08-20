export function isDefaultTitle(title: string) {
  return /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title)
}

type ChronologicalMessage = {
  id: string
  time: { created: number }
}

type RevertBoundary = {
  messageID: string
  messageTimeCreated?: number
}

export function compareMessageChronology(left: ChronologicalMessage, right: ChronologicalMessage) {
  return left.time.created - right.time.created || compareID(left.id, right.id)
}

export function compareMessageToRevert(message: ChronologicalMessage, revert: RevertBoundary) {
  if (revert.messageTimeCreated === undefined) return compareID(message.id, revert.messageID)
  return message.time.created - revert.messageTimeCreated || compareID(message.id, revert.messageID)
}

export function latestMessage<T extends ChronologicalMessage>(messages: T[], predicate: (message: T) => boolean) {
  return messages
    .filter(predicate)
    .reduce<
      T | undefined
    >((latest, message) => (!latest || compareMessageChronology(message, latest) > 0 ? message : latest), undefined)
}

export function earliestMessage<T extends ChronologicalMessage>(messages: T[], predicate: (message: T) => boolean) {
  return messages
    .filter(predicate)
    .reduce<
      T | undefined
    >((earliest, message) => (!earliest || compareMessageChronology(message, earliest) < 0 ? message : earliest), undefined)
}

function compareID(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}
