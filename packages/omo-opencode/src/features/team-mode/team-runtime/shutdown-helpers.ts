import { randomUUID } from "node:crypto"
import { readdir, rm } from "node:fs/promises"
import path from "node:path"

import type { Message, RuntimeState } from "../types"
import { getNativeTeamWorktrees, type NativeTeamWorktree } from "../../../v2/native-team-worktrees"
import { NativeWorktreeKeptError, type NativeWorktreeStatus } from "../../../v2/native-team-worktree-status"
import { log } from "../../../shared/logger"

type WorktreeMember = {
  readonly name?: string
  readonly worktreePath?: string
  readonly nativeWorktree?: NativeTeamWorktree
}
export type KeptMemberWorktree = NativeWorktreeStatus & { readonly member: string }
export type MemberWorktreeCleanupReport = { removedWorktrees: string[]; keptWorktrees: KeptMemberWorktree[] }

export async function inspectMemberWorktrees(
  members: readonly WorktreeMember[],
  owner?: object,
): Promise<KeptMemberWorktree[]> {
  const kept: KeptMemberWorktree[] = []
  for (const member of members) {
    if (!member.nativeWorktree) continue
    const worktrees = getNativeTeamWorktrees(owner)
    const status = worktrees
      ? await worktrees.inspect(member.nativeWorktree)
      : {
          directory: member.nativeWorktree.directory,
          exists: true,
          reason: "native host worktree domain is unavailable",
        }
    if (status.reason) kept.push({ ...status, member: member.name ?? "unknown" })
  }
  return kept
}

export class TeamWorktreesKeptError extends Error {
  constructor(public readonly keptWorktrees: readonly KeptMemberWorktree[]) {
    super(
      `team_delete refused; member work must be resolved:\n${keptWorktrees
        .map(
          (entry) =>
            `${entry.member}: ${entry.directory}: ${entry.reason}; HEAD ${entry.shortSha ?? "unknown"}${entry.ahead === undefined ? "" : `; ${entry.ahead} commits ahead`}`,
        )
        .join(
          "\n",
        )}\nHave members commit unfinished work, then merge their SHAs into the lead's branch (git merge --no-ff <sha>). Report these kept worktrees, paths, SHAs and reasons to the user. Discarding member work requires explicit user approval; do not force-remove worktrees to complete cleanup. Retry team_delete after integration or an explicitly user-approved discard. force only permits stopping active members; it never discards work.`,
    )
    this.name = "TeamWorktreesKeptError"
  }
}

export const DELETABLE_MEMBER_STATUSES = new Set<RuntimeState["members"][number]["status"]>([
  "completed",
  "shutdown_approved",
  "errored",
])

export function createShutdownMessage(from: string, to: string, kind: Message["kind"], body: string): Message {
  return {
    version: 1,
    messageId: randomUUID(),
    from,
    to,
    kind,
    body,
    timestamp: Date.now(),
  }
}

export function getRuntimeMember(runtimeState: RuntimeState, memberName: string): RuntimeState["members"][number] {
  const member = runtimeState.members.find((candidate) => candidate.name === memberName)
  if (!member) {
    throw new Error(`unknown member '${memberName}'`)
  }
  if (member.removal) throw new Error(`member '${memberName}' removal pending`)

  return member
}

export function getLeadMemberName(runtimeState: RuntimeState): string {
  const leadMember = runtimeState.members.find((member) => member.agentType === "leader")
  if (!leadMember) {
    throw new Error(`team '${runtimeState.teamRunId}' is missing a lead member`)
  }

  return leadMember.name
}

export function createSendContext(
  runtimeState: RuntimeState,
  senderName: string,
): { isLead: boolean; activeMembers: string[] } {
  const sender = getRuntimeMember(runtimeState, senderName)
  return {
    isLead: sender.agentType === "leader",
    activeMembers: runtimeState.members.filter((member) => !member.removal).map((member) => member.name),
  }
}

export function findLatestShutdownRequestIndex(
  runtimeState: RuntimeState,
  memberName: string,
  requesterName?: string,
): number {
  for (let index = runtimeState.shutdownRequests.length - 1; index >= 0; index -= 1) {
    const shutdownRequest = runtimeState.shutdownRequests[index]
    if (shutdownRequest.memberId !== memberName) continue
    if (requesterName !== undefined && shutdownRequest.requesterName !== requesterName) continue
    return index
  }

  return -1
}

export async function removeWorktrees(
  memberPaths: Array<string | undefined>,
  preservedDirectories: readonly string[] = [],
): Promise<string[]> {
  const removedWorktrees: string[] = []

  for (const memberPath of new Set(memberPaths)) {
    if (!memberPath) continue
    if (
      preservedDirectories.some(
        (directory) =>
          path.resolve(directory) === path.resolve(memberPath) ||
          path.resolve(memberPath).startsWith(`${path.resolve(directory)}${path.sep}`),
      )
    )
      continue
    if (
      preservedDirectories.some((directory) => {
        const relative = path.relative(memberPath, directory)
        return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      })
    ) {
      const entries = await readdir(memberPath)
      await removeWorktrees(
        entries.map((entry) => path.join(memberPath, entry)),
        preservedDirectories,
      )
      continue
    }
    await rm(memberPath, { recursive: true, force: true })
    removedWorktrees.push(memberPath)
  }

  return removedWorktrees
}

export async function removeMemberWorktrees(
  members: readonly WorktreeMember[],
  owner?: object,
): Promise<MemberWorktreeCleanupReport> {
  const removed: string[] = []
  const kept = await inspectMemberWorktrees(members, owner)
  for (const member of members) {
    const directory = member.nativeWorktree?.directory ?? member.worktreePath
    if (!directory || removed.includes(directory)) continue
    if (kept.some((entry) => entry.directory === directory)) continue
    if (member.nativeWorktree) {
      const worktrees = getNativeTeamWorktrees(owner)
      if (!worktrees) throw new Error("Native team worktree cleanup requires its host worktree domain")
      try {
        await worktrees.remove(member.nativeWorktree)
      } catch (error) {
        if (!(error instanceof NativeWorktreeKeptError)) throw error
        kept.push({ ...error.worktree, member: member.name ?? "unknown" })
        continue
      }
    } else {
      const removedLegacy = await removeWorktrees(
        [directory],
        kept.map((entry) => entry.directory),
      )
      removed.push(...removedLegacy)
      continue
    }
    removed.push(directory)
  }
  for (const worktree of kept) log("team native worktree kept", worktree)
  return { removedWorktrees: removed, keptWorktrees: kept }
}
