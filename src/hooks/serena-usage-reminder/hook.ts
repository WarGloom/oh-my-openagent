import { getSessionAgent } from "../../features/claude-code-session-state"
import { log } from "../../shared"
import { getAgentConfigKey } from "../../shared/agent-display-names"
import { isSerenaServerAvailable } from "../../shared/serena-availability"
import {
  EXCLUDED_AGENT_KEYS,
  GREP_TOOLS,
  GREP_USES_THRESHOLD,
  MIN_DENY_INTERVAL_MS,
  NON_SYMBOLIC_USES_THRESHOLD,
  READ_TOOLS,
  READ_USES_THRESHOLD,
  SERENA_TOOL_PREFIX,
} from "./constants"

type HookInput = {
  tool: string
  sessionID: string
  callID: string
}

type SessionState = {
  grepCount: number
  readCount: number
  nonSymbolicCount: number
  lastDenyTimestamp: number | null
}

function isSerenaTool(toolName: string): boolean {
  return toolName.includes(SERENA_TOOL_PREFIX)
}

function isGrepTool(toolName: string): boolean {
  return GREP_TOOLS.has(toolName)
}

function isReadTool(toolName: string): boolean {
  return READ_TOOLS.has(toolName)
}

function shouldEnforceForAgent(agentName: string | undefined): boolean {
  if (!agentName) return true
  return !EXCLUDED_AGENT_KEYS.has(getAgentConfigKey(agentName))
}

function resetCounters(state: SessionState): void {
  state.grepCount = 0
  state.readCount = 0
  state.nonSymbolicCount = 0
}

function buildGrepDeny(): string {
  return [
    "Too many consecutive grep calls without using symbolic tools.",
    "Consider using Serena's symbolic MCP tools instead for more code-centric search.",
    "You can continue using grep now if needed, the counter was reset.",
  ].join("\n")
}

function buildReadDeny(): string {
  return [
    "Too many consecutive read/glob calls without using symbolic tools.",
    "Consider using Serena's symbolic MCP tools instead for more targeted reads.",
    "You can continue using read now if needed, the counter was reset.",
  ].join("\n")
}

function buildNonSymbolicDeny(): string {
  return [
    "Too many consecutive non-symbolic tool calls (mixed grep and read/glob).",
    "Consider using Serena's symbolic search and targeted symbol reads instead.",
    "You can continue using these tools now if needed, the counter was reset.",
  ].join("\n")
}

function detectDeny(state: SessionState, isGrep: boolean, isRead: boolean): string | null {
  const tooManyGreps = state.grepCount >= GREP_USES_THRESHOLD
  const tooManyReads = state.readCount >= READ_USES_THRESHOLD
  const tooManyNonSymbolic = state.nonSymbolicCount >= NON_SYMBOLIC_USES_THRESHOLD

  if (isGrep && tooManyGreps) return buildGrepDeny()
  if (isRead && tooManyReads) return buildReadDeny()
  if (tooManyGreps) return buildGrepDeny()
  if (tooManyReads) return buildReadDeny()
  if (tooManyNonSymbolic) return buildNonSymbolicDeny()
  return null
}

export function createSerenaUsageReminderHook() {
  const serenaAvailable = isSerenaServerAvailable()
  const sessionStates = new Map<string, SessionState>()

  const getState = (sessionID: string): SessionState => {
    const existing = sessionStates.get(sessionID)
    if (existing) return existing

    const initial: SessionState = {
      grepCount: 0,
      readCount: 0,
      nonSymbolicCount: 0,
      lastDenyTimestamp: null,
    }
    sessionStates.set(sessionID, initial)
    return initial
  }

  return {
    "tool.execute.before": async (
      input: HookInput,
      _output: { args: Record<string, unknown> },
    ) => {
      if (!serenaAvailable) return

      const agentName = getSessionAgent(input.sessionID)
      if (!shouldEnforceForAgent(agentName)) return

      const toolName = input.tool.toLowerCase()
      const state = getState(input.sessionID)

      if (state.lastDenyTimestamp !== null) {
        if (Date.now() - state.lastDenyTimestamp < MIN_DENY_INTERVAL_MS) return
      }

      if (isSerenaTool(toolName)) {
        resetCounters(state)
        return
      }

      const isGrep = isGrepTool(toolName)
      const isRead = isReadTool(toolName)

      if (!isGrep && !isRead) return

      if (isGrep) state.grepCount++
      if (isRead) state.readCount++
      state.nonSymbolicCount++

      const denyMessage = detectDeny(state, isGrep, isRead)
      if (!denyMessage) return

      resetCounters(state)
      state.lastDenyTimestamp = Date.now()

      log("[serena-usage-reminder] Denying non-symbolic tool overuse", {
        sessionID: input.sessionID,
        callID: input.callID,
        tool: input.tool,
        agent: agentName,
      })

      throw new Error(denyMessage)
    },

    event: async (input: { event: { type: string; properties?: Record<string, unknown> } }) => {
      if (input.event.type !== "session.deleted") return

      const sessionID = input.event.properties?.info
      if (
        typeof sessionID === "object"
        && sessionID !== null
        && "id" in sessionID
        && typeof sessionID.id === "string"
      ) {
        sessionStates.delete(sessionID.id)
      }
    },
  }
}
