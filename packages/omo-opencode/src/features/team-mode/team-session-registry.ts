import type { TeamModeConfig } from "../../config/schema/team-mode"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { RuntimeStateSchema } from "@oh-my-opencode/team-core/types"
import type { RuntimeState } from "@oh-my-opencode/team-core/types"
import { isPlainRecord } from "@oh-my-opencode/utils/record-type-guard"
import { resolveBaseDir } from "./team-registry/paths"

export type TeamSessionRole = "lead" | "member"

export type TeamSessionEntry = {
  teamRunId: string
  memberName: string
  role: TeamSessionRole
}

const registry = new Map<string, TeamSessionEntry>()
const denied = new Set<string>()
const removalConfigs = new Map<string, TeamModeConfig>()

export function configureTeamSessionRemoval(config: TeamModeConfig | undefined): void {
  if (config?.enabled) removalConfigs.set(path.resolve(resolveBaseDir(config)), config)
}

export class TeamSessionRemovalDeniedError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Session ${sessionId} is fenced or removed from its team`)
    this.name = "TeamSessionRemovalDeniedError"
  }
}

export function assertTeamSessionCanContinue(sessionId: string, config?: TeamModeConfig): void {
  if (isTeamSessionDenied(sessionId, config)) throw new TeamSessionRemovalDeniedError(sessionId)
}

export function denyTeamSession(sessionId: string): void {
  registry.delete(sessionId)
  denied.add(sessionId)
}

export function isTeamSessionDenied(sessionId: string, config?: TeamModeConfig): boolean {
  if (denied.has(sessionId)) return true
  return readSessionRuntimeStates(sessionId, config).some(
    (state) =>
      state === null ||
      state.members.some((member) => member.removal?.sessionId === sessionId) ||
      state.removedMembers?.some((record) => record.member.sessionId === sessionId),
  )
}

function rawStateContainsSession(raw: unknown, sessionId: string): boolean {
  if (!isPlainRecord(raw)) return false
  if (raw.leadSessionId === sessionId) return true
  if (
    Array.isArray(raw.members) &&
    raw.members.some(
      (member) =>
        isPlainRecord(member) &&
        (member.sessionId === sessionId || (isPlainRecord(member.removal) && member.removal.sessionId === sessionId)),
    )
  )
    return true
  return (
    Array.isArray(raw.removedMembers) &&
    raw.removedMembers.some(
      (record) => isPlainRecord(record) && isPlainRecord(record.member) && record.member.sessionId === sessionId,
    )
  )
}

function readSessionRuntimeStates(sessionId: string, config?: TeamModeConfig): Array<RuntimeState | null> {
  const configs = new Map(removalConfigs)
  if (config?.enabled) configs.set(path.resolve(resolveBaseDir(config)), config)
  return [...configs.values()].flatMap((rootConfig) => readRootSessionStates(sessionId, rootConfig))
}

function readRootSessionStates(sessionId: string, config: TeamModeConfig): Array<RuntimeState | null> {
  const directory = path.join(resolveBaseDir(config), "runtime")
  const states: Array<RuntimeState | null> = []
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const registeredRun = registry.get(sessionId)?.teamRunId === entry.name
      let raw: unknown
      try {
        raw = JSON.parse(readFileSync(path.join(directory, entry.name, "state.json"), "utf8"))
      } catch (error) {
        if (registeredRun) states.push(null)
        else if (!(error instanceof SyntaxError || (error instanceof Error && "code" in error))) throw error
        continue
      }
      if (!registeredRun && !rawStateContainsSession(raw, sessionId)) continue
      const parsed = RuntimeStateSchema.safeParse(raw)
      states.push(parsed.success ? parsed.data : null)
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
  }
  return states
}

export function isKnownTeamSession(sessionId: string): boolean {
  if (registry.has(sessionId) || isTeamSessionDenied(sessionId)) return true
  return readSessionRuntimeStates(sessionId).some(
    (state) =>
      state === null ||
      state.leadSessionId === sessionId ||
      state.members.some((member) => member.sessionId === sessionId),
  )
}

/** True while a team run led by this session has a non-lead member that is still working.
 *  Reads the persisted runtime state: member background tasks can report completed between turns. */
export function hasActiveTeamMemberWork(leadSessionId: string, config?: TeamModeConfig): boolean {
  return readSessionRuntimeStates(leadSessionId, config).some(
    (state) =>
      state !== null &&
      state.status === "active" &&
      state.leadSessionId === leadSessionId &&
      state.members.some(
        (member) => member.sessionId !== leadSessionId && (member.status === "running" || member.status === "pending"),
      ),
  )
}

export function registerTeamSession(sessionId: string, entry: TeamSessionEntry): void {
  if (isTeamSessionDenied(sessionId)) return
  registry.set(sessionId, entry)
}

export function lookupTeamSession(sessionId: string): TeamSessionEntry | undefined {
  if (isTeamSessionDenied(sessionId)) return undefined
  const entry = registry.get(sessionId)
  if (!entry || removalConfigs.size === 0) return entry
  const state = readSessionRuntimeStates(sessionId).find((candidate) => candidate?.teamRunId === entry.teamRunId)
  const member = state?.members.find((candidate) => candidate.name === entry.memberName)
  if (
    !member ||
    member.removal ||
    (member.sessionId !== sessionId && !(member.sessionId === undefined && member.status === "pending"))
  )
    return undefined
  return {
    ...entry,
    role: state?.leadSessionId === undefined ? entry.role : state.leadSessionId === sessionId ? "lead" : "member",
  }
}

export function unregisterTeamSession(sessionId: string): void {
  registry.delete(sessionId)
}

export function unregisterTeamSessionsByTeam(teamRunId: string): void {
  for (const [sessionId, entry] of registry.entries()) {
    if (entry.teamRunId === teamRunId) {
      registry.delete(sessionId)
    }
  }
}

export function clearTeamSessionRegistry(): void {
  registry.clear()
  denied.clear()
  removalConfigs.clear()
}
