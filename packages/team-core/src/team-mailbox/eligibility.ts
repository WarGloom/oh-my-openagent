import type { Message, RuntimeState } from "../types"

type Member = RuntimeState["members"][number]
type MemberSelection =
  | { readonly kind: "missing" }
  | { readonly kind: "stale" }
  | { readonly kind: "matched"; readonly member: Member }

export function selectMailboxMember(state: RuntimeState, memberName: string, expectedSessionID: string | undefined): MemberSelection {
  const member = state.members.find((candidate) => candidate.name === memberName)
  if (member === undefined) return { kind: "missing" }
  if (member.sessionId !== expectedSessionID) return { kind: "stale" }
  return { kind: "matched", member }
}

export function selectUnreadMailboxMessages(member: Member, messages: readonly Message[]): Message[] {
  const pending = new Set(member.pendingInjectedMessageIds)
  return messages.filter((message) => !pending.has(message.messageId))
}
