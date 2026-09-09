import type { RuntimeState, RuntimeStateMember } from "../types"

export type MemberAdmissionErrorCode = "at_capacity" | "duplicate_name" | "run_not_active"

export class MemberAdmissionError extends Error {
  constructor(message: string, public readonly code: MemberAdmissionErrorCode) {
    super(message)
    this.name = "MemberAdmissionError"
  }
}

// A claim identifies one owned pending addition. The claimId is revalidated at the
// final commit so a concurrent delete or a rolled-back sibling cannot let this add
// register success against a row it no longer owns.
export type AdmittedMemberClaim = {
  readonly memberName: string
  readonly claimId: string
}

// create-path admission: the whole spec is admitted at once against the cap the run
// snapshots into bounds.maxMembers. Counting the full roster (lead included) mirrors
// the add path, so a run started at the cap cannot then be grown.
export function assertRosterWithinCapacity(memberCount: number, maxMembers: number, teamName: string): void {
  if (memberCount > maxMembers) {
    throw new MemberAdmissionError(
      `Team '${teamName}' declares ${memberCount} members but the configured max_members cap is ${maxMembers}. Reduce the roster, or raise max_members for a new run.`,
      "at_capacity",
    )
  }
}

// add-path admission, evaluated inside the state lock. Counts EVERY roster row —
// lead, terminal, and pending — against the run's immutable bounds.maxMembers, and
// rejects a duplicate name or a non-active run non-destructively (never mutates state
// on rejection). Returns the pending row to append plus the owned claim.
export function admitAddedMember(
  state: RuntimeState,
  candidateName: string,
  claimId: string,
): { claim: AdmittedMemberClaim; member: RuntimeStateMember } {
  if (state.status !== "active") {
    throw new MemberAdmissionError(
      `team_add_member denied: run ${state.teamRunId} is '${state.status}', not 'active'. Members can only be added to an active run.`,
      "run_not_active",
    )
  }

  if (state.members.some((member) => member.name === candidateName)) {
    throw new MemberAdmissionError(
      `team_add_member denied: member '${candidateName}' already exists in run ${state.teamRunId}. Member names are unique for the life of a run.`,
      "duplicate_name",
    )
  }

  if (state.members.length >= state.bounds.maxMembers) {
    throw new MemberAdmissionError(
      `team_add_member denied: run ${state.teamRunId} is at capacity (${state.members.length}/${state.bounds.maxMembers} members, counting the lead and any finished members). Raising max_members applies to new runs only; it never reclaims a finished member's slot.`,
      "at_capacity",
    )
  }

  const member: RuntimeStateMember = {
    name: candidateName,
    agentType: "general-purpose",
    status: "pending",
    pendingInjectedMessageIds: [],
    provisioningClaimId: claimId,
  }

  return { claim: { memberName: candidateName, claimId }, member }
}

// Final-commit guard: the exact pending row must still exist under this claimId and
// the run must still be active. Any other outcome (row removed, claim overwritten by a
// later add, run moving to deleting) means ownership was lost and the addition rolls back.
export function isClaimStillOwned(state: RuntimeState, claim: AdmittedMemberClaim): boolean {
  if (state.status !== "active") return false
  const member = state.members.find((candidate) => candidate.name === claim.memberName)
  return member !== undefined && member.provisioningClaimId === claim.claimId
}
