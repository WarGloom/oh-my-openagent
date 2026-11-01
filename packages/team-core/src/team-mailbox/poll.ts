import type { TeamModeConfig } from "../config"
import { transitionRuntimeState } from "../team-state-store/store"
import type { Message } from "../types"
import { listUnreadMessages } from "./inbox"
import { selectMailboxMember, selectUnreadMailboxMessages } from "./eligibility"

export interface InjectionResult {
  injected: boolean
  content?: string
  messageIds: string[]
  reason?: string
}

type InjectionClaim = {
  readonly resolvedSessionID: string | undefined
  readonly insertContent: (content: string) => void
}

function escapeAttributeValue(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&apos;")
}

export function buildEnvelope(message: Message): string {
  const attributes = [
    `from="${escapeAttributeValue(message.from)}"`,
    `timestamp="${escapeAttributeValue(String(message.timestamp))}"`,
    `messageId="${escapeAttributeValue(message.messageId)}"`,
    `kind="${escapeAttributeValue(message.kind)}"`,
    `correlationId="${escapeAttributeValue(message.correlationId ?? "")}"`,
  ]

  if (message.summary !== undefined) {
    attributes.push(`summary="${escapeAttributeValue(message.summary)}"`)
  }

  if (message.references !== undefined) {
    attributes.push(`references="${escapeAttributeValue(JSON.stringify(message.references))}"`)
  }

  return `<peer_message ${attributes.join(" ")}>
${message.body}
</peer_message>`
}

export async function pollAndBuildInjection(
  sessionID: string,
  memberName: string,
  teamRunId: string,
  config: TeamModeConfig,
  turnMarker: string,
  claim: InjectionClaim,
): Promise<InjectionResult> {
  const unreadMessages = await listUnreadMessages(teamRunId, memberName, config)
  let result: InjectionResult | undefined

  await transitionRuntimeState(teamRunId, (currentRuntimeState) => {
    const selection = selectMailboxMember(currentRuntimeState, memberName, claim.resolvedSessionID)
    if (selection.kind === "missing") {
      throw new Error(`runtime member not found for session ${sessionID}: ${memberName}`)
    }
    if (selection.kind === "stale") {
      result = { injected: false, messageIds: [], reason: "stale session" }
      return currentRuntimeState
    }
    const runtimeMember = selection.member

    if (runtimeMember.lastInjectedTurnMarker === turnMarker) {
      result = { injected: false, messageIds: [], reason: "already injected this turn" }
      return currentRuntimeState
    }

    const injectableMessages = selectUnreadMailboxMessages(runtimeMember, unreadMessages)
    if (injectableMessages.length === 0) {
      result = runtimeMember.pendingInjectedMessageIds.length > 0
        ? { injected: false, messageIds: [], reason: "pending ack" }
        : { injected: false, messageIds: [], reason: "no unread" }
      return currentRuntimeState
    }

    const messageIds: string[] = []
    const envelopes: string[] = []
    for (const unreadMessage of injectableMessages) {
      messageIds.push(unreadMessage.messageId)
      envelopes.push(buildEnvelope(unreadMessage))
    }
    const content = envelopes.join("\n")
    claim.insertContent(content)
    result = { injected: true, content, messageIds }

    return {
      ...currentRuntimeState,
      members: currentRuntimeState.members.map((member) => (
        member.name === memberName
          ? {
            ...member,
            lastInjectedTurnMarker: turnMarker,
            pendingInjectedMessageIds: Array.from(new Set([...member.pendingInjectedMessageIds, ...messageIds])),
          }
          : member
      )),
    }
  }, config)

  if (result === undefined) {
    throw new Error(`mailbox injection claim failed for session ${sessionID}: ${memberName}`)
  }

  return result
}
