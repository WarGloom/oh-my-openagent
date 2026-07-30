import type { TeamModeConfig } from "../../config/schema/team-mode"
import { ackMessages } from "../../features/team-mode/team-mailbox/ack"
import { withInboxConsumerLease } from "../../features/team-mode/team-mailbox"
import {
  findDeliveredMessageIds,
  requeuePendingLiveDeliveries,
} from "../../features/team-mode/team-mailbox/pending-delivery-recovery"
import {
  inspectDeliveryReservationState,
} from "../../features/team-mode/team-mailbox/reservation"
import { loadRuntimeState, transitionRuntimeState } from "../../features/team-mode/team-state-store/store"
import type { RuntimeState } from "../../features/team-mode/types"

type SessionMessagesClient = {
  readonly session?: {
    readonly messages?: (input: { path: { id: string } }) => Promise<unknown>
  }
}

type ClaimGroups = {
  readonly inbox: string[]
  readonly reserved: string[]
  readonly processed: string[]
  readonly missing: string[]
}

export type IdleClaimSettlement = {
  readonly kind: "settled" | "stale-session"
  readonly ackedCount: number
  readonly requeuedCount: number
  readonly unresolvedCount: number
}

export type TerminalClaimSettlement =
  | { readonly kind: "message-delivered"; readonly pendingCount: number }
  | { readonly kind: "stale-session"; readonly runtimeState: RuntimeState }
  | { readonly kind: "already-settled" }
  | {
      readonly kind: "settled"
      readonly runtimeState: RuntimeState
      readonly requeuedCount: number
      readonly unresolvedCount: number
    }

type ClaimIdentity = {
  readonly teamRunId: string
  readonly memberName: string
  readonly sessionID: string
  readonly config: TeamModeConfig
}

type IdleSettlementInput = ClaimIdentity & { readonly client: SessionMessagesClient }
type TerminalSettlementInput = ClaimIdentity & { readonly client?: SessionMessagesClient }

type SettlementDeps = {
  readonly transitionRuntimeState?: typeof transitionRuntimeState
}

type MemberSettlementCommit = {
  readonly input: ClaimIdentity
  readonly expectedSessionID: string | undefined
  readonly resolvedMessageIds: ReadonlySet<string>
  readonly markErrored: boolean
  readonly transition: typeof transitionRuntimeState
}

async function classifyClaims(input: ClaimIdentity, messageIds: readonly string[]): Promise<ClaimGroups> {
  const groups: ClaimGroups = { inbox: [], reserved: [], processed: [], missing: [] }
  for (const messageId of messageIds) {
    const state = await inspectDeliveryReservationState(input.teamRunId, input.memberName, messageId, input.config)
    groups[state].push(messageId)
  }
  return groups
}

function findMatchingMember(runtimeState: RuntimeState, input: ClaimIdentity): RuntimeState["members"][number] | undefined {
  const member = runtimeState.members.find(({ name }) => name === input.memberName)
  if (member === undefined || (member.sessionId !== undefined && member.sessionId !== input.sessionID)) return undefined
  return member
}

async function persistMemberSettlement(commit: MemberSettlementCommit) {
  let stateWasUpdated = false
  const runtimeState = await commit.transition(
    commit.input.teamRunId,
    (currentRuntimeState) => {
      const currentMember = currentRuntimeState.members.find((member) => member.name === commit.input.memberName)
      if (currentMember === undefined || currentMember.sessionId !== commit.expectedSessionID) {
        return currentRuntimeState
      }
      stateWasUpdated = true
      return {
        ...currentRuntimeState,
        members: currentRuntimeState.members.map((member) => {
          if (member.name !== commit.input.memberName) return member
          const pendingInjectedMessageIds = member.pendingInjectedMessageIds.filter(
            (id) => !commit.resolvedMessageIds.has(id),
          )
          if (!commit.markErrored) return { ...member, pendingInjectedMessageIds }
          const { lastInjectedTurnMarker: _turnMarker, ...memberWithoutTurnMarker } = member
          return {
            ...memberWithoutTurnMarker,
            status: "errored",
            pendingInjectedMessageIds,
          }
        }),
      }
    },
    commit.input.config,
  )
  return { committed: stateWasUpdated, runtimeState }
}

export async function settleIdleClaims(
  input: IdleSettlementInput,
  deps: SettlementDeps = {},
): Promise<IdleClaimSettlement> {
  return withInboxConsumerLease(
    input.teamRunId,
    input.memberName,
    input.config,
    async () => {
      const runtimeState = await loadRuntimeState(input.teamRunId, input.config)
      const member = findMatchingMember(runtimeState, input)
      if (member === undefined) return { kind: "stale-session", ackedCount: 0, requeuedCount: 0, unresolvedCount: 0 }

      const pendingMessageIds = member.pendingInjectedMessageIds
      const claims = await classifyClaims(input, pendingMessageIds)
      const deliveredReservedIds = await findDeliveredMessageIds(input.client, input.sessionID, claims.reserved)
      const reservedToAck = claims.reserved.filter((id) => deliveredReservedIds.has(id))
      const reservedToRequeue = claims.reserved.filter((id) => !deliveredReservedIds.has(id))
      const commit = await persistMemberSettlement({
        input,
        expectedSessionID: member.sessionId,
        resolvedMessageIds: new Set([...claims.inbox, ...claims.reserved, ...claims.processed]),
        markErrored: false,
        transition: deps.transitionRuntimeState ?? transitionRuntimeState,
      })
      if (!commit.committed) {
        return { kind: "stale-session", ackedCount: 0, requeuedCount: 0, unresolvedCount: pendingMessageIds.length }
      }

      const messageIdsToAck = reservedToAck
      const ackedMessageIds = messageIdsToAck.length === 0
        ? []
        : await ackMessages(input.teamRunId, input.memberName, messageIdsToAck, input.config)
      const requeuedMessageIds =
        reservedToRequeue.length === 0
          ? []
          : await requeuePendingLiveDeliveries(input.teamRunId, input.memberName, reservedToRequeue, input.config)
      return {
        kind: "settled",
        ackedCount: ackedMessageIds.length,
        requeuedCount: requeuedMessageIds.length,
        unresolvedCount: claims.missing.length,
      }
    },
    { staleAfterMs: 0 },
  )
}

export async function settleTerminalErrorClaims(
  input: TerminalSettlementInput,
  deps: SettlementDeps = {},
): Promise<TerminalClaimSettlement> {
  return withInboxConsumerLease(
    input.teamRunId,
    input.memberName,
    input.config,
    async () => {
      const runtimeState = await loadRuntimeState(input.teamRunId, input.config)
      const member = findMatchingMember(runtimeState, input)
      if (member === undefined) return { kind: "stale-session", runtimeState }

      const pendingMessageIds = member.pendingInjectedMessageIds
      if (member.status === "errored" && pendingMessageIds.length === 0) return { kind: "already-settled" }

      const claims = await classifyClaims(input, pendingMessageIds)
      const deliveredReservedIds =
        input.client === undefined
          ? new Set<string>()
          : await findDeliveredMessageIds(input.client, input.sessionID, claims.reserved)
      const allPendingClaimsAreDeliveredReservations =
        pendingMessageIds.length > 0 &&
        claims.reserved.length === pendingMessageIds.length &&
        claims.inbox.length === 0 &&
        claims.processed.length === 0 &&
        claims.missing.length === 0 &&
        claims.reserved.every((messageId) => deliveredReservedIds.has(messageId))
      const messageIdsToRequeue = [...claims.inbox, ...claims.reserved]
      const commit = await persistMemberSettlement({
        input,
        expectedSessionID: member.sessionId,
        resolvedMessageIds: allPendingClaimsAreDeliveredReservations
          ? new Set()
          : new Set([...claims.inbox, ...claims.reserved, ...claims.processed]),
        markErrored: !allPendingClaimsAreDeliveredReservations,
        transition: deps.transitionRuntimeState ?? transitionRuntimeState,
      })
      if (!commit.committed) return { kind: "stale-session", runtimeState: commit.runtimeState }
      if (allPendingClaimsAreDeliveredReservations) {
        return { kind: "message-delivered", pendingCount: pendingMessageIds.length }
      }

      const requeuedMessageIds =
        messageIdsToRequeue.length === 0
          ? []
          : await requeuePendingLiveDeliveries(input.teamRunId, input.memberName, messageIdsToRequeue, input.config)
      return {
        kind: "settled",
        runtimeState: commit.runtimeState,
        requeuedCount: requeuedMessageIds.length,
        unresolvedCount: claims.missing.length,
      }
    },
    { staleAfterMs: 0 },
  )
}
