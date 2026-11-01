import type { KeywordDetectorConfig } from "../../config/schema/keyword-detector"
import type { TeamModeConfig } from "../../config/schema/team-mode"
import { isRealUserMessage } from "../../shared/internal-initiator-marker"
import { detectKeywordsWithType, extractPromptText } from "../keyword-detector/detector"
import { listActiveTeams, loadRuntimeState } from "@oh-my-opencode/team-core/team-state-store/store"

type TransformPart = {
  type: string
  text?: string
  synthetic?: boolean
  [key: string]: unknown
}

type TransformMessageInfo = {
  role: string
  sessionID?: string
  [key: string]: unknown
}

type MessageWithParts = {
  info: TransformMessageInfo
  parts: TransformPart[]
}

type TeamModeStatusInjectorInput = {
  sessionID?: string
  [key: string]: unknown
}

type TeamModeStatusInjectorOutput = {
  messages: MessageWithParts[]
}

export type TeamModeStatusInjectorHook = {
  readonly nativeStatusForPrompt: (parts: TransformPart[]) => string | undefined
  readonly nativeHasActiveTeam: (sessionID: string) => Promise<boolean>
  "experimental.chat.messages.transform"?: (
    input: TeamModeStatusInjectorInput,
    output: TeamModeStatusInjectorOutput,
  ) => Promise<void>
}

const TEAM_MODE_STATUS_MARKER = '<team_mode_status enabled="true">'

function resolveSessionID(input: TeamModeStatusInjectorInput, messages: MessageWithParts[]): string | undefined {
  if (typeof input.sessionID === "string" && input.sessionID.length > 0) {
    return input.sessionID
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const sessionID = messages[index]?.info.sessionID
    if (typeof sessionID === "string" && sessionID.length > 0) {
      return sessionID
    }
  }

  return undefined
}

function findLastUserMessageIndex(messages: MessageWithParts[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.info.role === "user") {
      return index
    }
  }

  return -1
}

function hasInjectedTeamModeStatus(messages: MessageWithParts[]): boolean {
  return messages.some((message) =>
    message.parts.some(
      (part) => part.synthetic === true && part.type === "text" && part.text?.includes(TEAM_MODE_STATUS_MARKER),
    ),
  )
}

function latestUserMessageRequestsTeamMode(
  messages: MessageWithParts[],
  userMessageIndex: number,
  config: TeamModeConfig,
  keywordDetectorConfig?: KeywordDetectorConfig,
): boolean {
  const message = messages[userMessageIndex]
  if (message === undefined) {
    return false
  }
  return teamModeStatusForPrompt(message.parts, config, keywordDetectorConfig) !== undefined
}

function teamModeRequested(parts: TransformPart[], keywordDetectorConfig?: KeywordDetectorConfig): boolean {
  const promptText = extractPromptText(parts)
  return detectKeywordsWithType(promptText, undefined, undefined, keywordDetectorConfig?.disabled_keywords).some(
    (keyword) => keyword.type === "team",
  )
}

export function teamModeStatusForPrompt(
  parts: TransformPart[],
  config: TeamModeConfig,
  keywordDetectorConfig?: KeywordDetectorConfig,
): string | undefined {
  if (!config.enabled || !isRealUserMessage({ info: { role: "user" }, parts })) return undefined
  return teamModeRequested(parts, keywordDetectorConfig) ? buildTeamModeStatusContent() : undefined
}

export function buildTeamModeStatusContent(): string {
  return `${TEAM_MODE_STATUS_MARKER}
Team mode is ENABLED for this session. Presence of the team_* tools is authoritative proof; do not inspect config files to verify.
Closure invariant: every team you open is yours to close. After each team_task_update that completes or fails a task, call team_task_list({ teamRunId }); if every task is terminal, run team_shutdown_request + team_approve_shutdown per active member, then team_delete in the same turn, without waiting for the user to ask. Lingering teams are a defect.
Load the team-mode skill for the full Closure Contract and Closure Sequence.
</team_mode_status>`
}

function createInjectedMessage(sessionID: string): MessageWithParts {
  return {
    info: {
      role: "user",
      sessionID,
    },
    parts: [{ type: "text", text: buildTeamModeStatusContent(), synthetic: true }],
  }
}

export function createTeamModeStatusInjector(
  config: TeamModeConfig,
  keywordDetectorConfig?: KeywordDetectorConfig,
): TeamModeStatusInjectorHook {
  return {
    nativeStatusForPrompt: (parts) => teamModeStatusForPrompt(parts, config, keywordDetectorConfig),
    nativeHasActiveTeam: async (sessionID) => {
      const teams = await listActiveTeams(config)
      for (const team of teams) {
        const state = await loadRuntimeState(team.teamRunId, config)
        if (state.leadSessionId === sessionID || state.members.some((member) => member.sessionId === sessionID))
          return true
      }
      return false
    },
    "experimental.chat.messages.transform": async (input, output): Promise<void> => {
      if (!config.enabled || output.messages.length === 0) {
        return
      }

      if (hasInjectedTeamModeStatus(output.messages)) {
        return
      }

      const sessionID = resolveSessionID(input, output.messages)
      if (sessionID === undefined) {
        return
      }

      const lastUserMessageIndex = findLastUserMessageIndex(output.messages)
      if (!latestUserMessageRequestsTeamMode(output.messages, lastUserMessageIndex, config, keywordDetectorConfig)) {
        return
      }

      const injectedMessage = createInjectedMessage(sessionID)

      output.messages.splice(lastUserMessageIndex, 0, injectedMessage)
    },
  }
}
