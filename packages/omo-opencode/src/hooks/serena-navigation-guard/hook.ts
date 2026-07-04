import { getSessionAgent } from "../../features/claude-code-session-state"
import path from "node:path"
import { log } from "../../shared"
import { getAgentConfigKey } from "../../shared/agent-display-names"
import { resolveSessionTools } from "../../shared/resolve-session-tools"
import {
  EXCLUDED_AGENT_KEYS,
  MANUAL_NAVIGATION_TOOLS,
  MAX_VIOLATIONS_BEFORE_FALLBACK,
  NON_CODE_FILE_EXTENSIONS,
  SERENA_NAVIGATION_TOOL_HINTS,
  SERENA_TOOL_PREFIX,
} from "./constants"

type HookInput = {
  tool: string
  sessionID: string
  callID: string
}

type HookOutput = {
  title?: string
  output?: string
  metadata?: Record<string, unknown>
  content?: Array<{
    type?: string
    text?: string
  }>
}

type SessionState = {
  failedSerenaAttempt: boolean
  violationCount: number
}

const TOOL_FAILURE_PATTERNS = [
  /^Error:/i,
  /^Failed\b/i,
  /\btool error\b/i,
  /\bno such tool\b/i,
]

function isSerenaTool(toolName: string): boolean {
  return toolName.toLowerCase().startsWith(SERENA_TOOL_PREFIX)
}

function isManualNavigationTool(toolName: string): boolean {
  return MANUAL_NAVIGATION_TOOLS.has(toolName.toLowerCase())
}

type SerenaNavigationGuardDeps = {
  client: {
    session: {
      messages: (input: { path: { id: string } }) => Promise<unknown>
    }
  }
}

function getToolOutputText(output: HookOutput): string | null {
  if (typeof output.output === "string") {
    return output.output
  }

  if (!Array.isArray(output.content)) {
    return null
  }

  const textParts = output.content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)

  if (textParts.length === 0) {
    return null
  }

  return textParts.join("\n")
}

function isToolFailure(output: HookOutput): boolean {
  const outputText = getToolOutputText(output)
  if (!outputText) {
    return false
  }

  return TOOL_FAILURE_PATTERNS.some((pattern) => pattern.test(outputText.trim()))
}

function shouldEnforceForAgent(agentName: string | undefined): boolean {
  if (!agentName) {
    return false
  }

  return !EXCLUDED_AGENT_KEYS.has(getAgentConfigKey(agentName))
}

function isObviousNonCodeRead(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName.toLowerCase() !== "read") {
    return false
  }

  const filePath = typeof args.filePath === "string" ? args.filePath : null
  if (!filePath) {
    return false
  }

  return NON_CODE_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function buildViolationMessage(toolName: string, violationCount: number): string {
  const reminder =
    violationCount === 0
      ? [
          "Serena-first navigation policy: Serena MCP tools are available in this session.",
          `Do not use \`${toolName}\` for project navigation before trying Serena.`,
          "Use Serena first for codebase structure, symbol lookup, and targeted reads.",
          `Start with: ${SERENA_NAVIGATION_TOOL_HINTS.join(", ")}`,
          "For obvious non-code files like docs, logs, and config files, use plain Read directly.",
          "If Serena fails to answer, retry with grep/glob/read afterwards.",
        ]
      : [
          "Serena-first navigation policy still applies.",
          `Retry with Serena before using \`${toolName}\`.`,
          "Obvious non-code files like docs, logs, and config files are fine to read directly.",
          "Plain grep/glob/read is allowed only after a Serena tool fails in this session.",
        ]

  return reminder.join("\n")
}

export function createSerenaNavigationGuardHook(deps: SerenaNavigationGuardDeps) {
  const sessionState = new Map<string, SessionState>()
  const serenaAccessBySession = new Map<string, boolean>()

  const hasSerenaToolAccess = async (sessionID: string): Promise<boolean> => {
    const cached = serenaAccessBySession.get(sessionID)
    if (cached !== undefined) {
      return cached
    }

    const sessionTools = await resolveSessionTools(deps.client, sessionID)
    const hasAccess = sessionTools
      ? Object.entries(sessionTools).some(([toolName, enabled]) => enabled && isSerenaTool(toolName))
      : false

    serenaAccessBySession.set(sessionID, hasAccess)
    return hasAccess
  }

  const getState = (sessionID: string): SessionState => {
    const existing = sessionState.get(sessionID)
    if (existing) {
      return existing
    }

    const initial: SessionState = {
      failedSerenaAttempt: false,
      violationCount: 0,
    }
    sessionState.set(sessionID, initial)
    return initial
  }

  return {
    "tool.execute.before": async (
      input: HookInput,
      output: { args: Record<string, unknown> },
    ) => {
      const toolName = input.tool.toLowerCase()
      if (!isManualNavigationTool(toolName)) {
        return
      }

      if (!(await hasSerenaToolAccess(input.sessionID))) {
        return
      }

      if (isObviousNonCodeRead(toolName, output.args)) {
        return
      }

      const agentName = getSessionAgent(input.sessionID)
      if (!shouldEnforceForAgent(agentName)) {
        return
      }

      const state = getState(input.sessionID)
      if (state.failedSerenaAttempt) {
        return
      }

      if (state.violationCount >= MAX_VIOLATIONS_BEFORE_FALLBACK) {
        log("[serena-navigation-guard] Circuit breaker tripped; allowing manual navigation fallback", {
          sessionID: input.sessionID,
          tool: input.tool,
          agent: agentName,
          violationCount: state.violationCount,
        })
        return
      }

      log("[serena-navigation-guard] Advising manual navigation after Serena-first reminder", {
        sessionID: input.sessionID,
        callID: input.callID,
        tool: input.tool,
        agent: agentName,
        violationCount: state.violationCount,
      })

      const message = buildViolationMessage(input.tool, state.violationCount)
      state.violationCount += 1
      log("[serena-navigation-guard] Soft advisory; allowing manual navigation", {
        sessionID: input.sessionID,
        callID: input.callID,
        tool: input.tool,
        agent: agentName,
        message,
      })
    },

    "tool.execute.after": async (input: HookInput, output: HookOutput) => {
      if (!isSerenaTool(input.tool)) {
        return
      }

      if (!(await hasSerenaToolAccess(input.sessionID))) {
        return
      }

      const state = getState(input.sessionID)
      if (isToolFailure(output)) {
        state.failedSerenaAttempt = true
        log("[serena-navigation-guard] Serena tool failed; enabling manual fallback", {
          sessionID: input.sessionID,
          callID: input.callID,
          tool: input.tool,
        })
        return
      }

      state.failedSerenaAttempt = false
      log("[serena-navigation-guard] Serena tool succeeded", {
        sessionID: input.sessionID,
        callID: input.callID,
        tool: input.tool,
      })
    },

    event: async (input: { event: { type: string; properties?: Record<string, unknown> } }) => {
      if (input.event.type !== "session.deleted") {
        return
      }

      const sessionID = input.event.properties?.info
      if (
        typeof sessionID === "object"
        && sessionID !== null
        && "id" in sessionID
        && typeof sessionID.id === "string"
      ) {
        sessionState.delete(sessionID.id)
        serenaAccessBySession.delete(sessionID.id)
      }
    },
  }
}
