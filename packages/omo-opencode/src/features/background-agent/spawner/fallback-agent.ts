import { buildBackgroundTaskPromptTools, type TaskPromptBody } from "./task-prompt-body"

export const FALLBACK_AGENT = "general"

export function isAgentNotFoundError(error: unknown): boolean {
  const message = getErrorMessage(error)
  return (
    message.includes("Agent not found") ||
    message.includes("agent.name")
  )
}

function getErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error
  }
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return String(error)
}

export function buildFallbackBody(
  originalBody: TaskPromptBody,
  fallbackAgent: string,
  options: { includeTeamToolDenylist?: boolean } = {},
): TaskPromptBody {
  const originalTools = originalBody.tools && typeof originalBody.tools === "object" && !Array.isArray(originalBody.tools)
    ? originalBody.tools as Record<string, unknown>
    : undefined
  const preservedDenies: Record<string, "deny"> = {}
  if (originalTools) {
    for (const [tool, value] of Object.entries(originalTools)) {
      if (value === false) preservedDenies[tool] = "deny"
    }
  }

  return {
    ...originalBody,
    agent: fallbackAgent,
    tools: buildBackgroundTaskPromptTools({
      agent: fallbackAgent,
      includeTeamToolDenylist: options.includeTeamToolDenylist ?? true,
      userPermission: preservedDenies,
    }),
  }
}
