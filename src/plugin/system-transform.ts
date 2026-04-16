import type { PluginContext } from "./types"

import { getSerenaNavigationPrompt } from "../shared/serena-navigation-prompt"
import { resolveSessionTools } from "../shared/resolve-session-tools"

function hasSerenaToolAccess(tools: Record<string, boolean> | undefined): boolean {
  if (!tools) {
    return false
  }

  return Object.entries(tools).some(([toolName, enabled]) => enabled && toolName.toLowerCase().startsWith("serena_"))
}

export function createSystemTransformHandler(args: {
  ctx: PluginContext
}): (
  input: { sessionID?: string; model: { id: string; providerID: string; [key: string]: unknown } },
  output: { system: string[] },
) => Promise<void> {
  const { ctx } = args

  return async (input, output): Promise<void> => {
    const sessionTools = input.sessionID
      ? await resolveSessionTools(ctx.client, input.sessionID)
      : undefined
    if (!hasSerenaToolAccess(sessionTools)) {
      return
    }

    if (output.system.some((entry) => entry.includes("<serena_navigation>"))) {
      return
    }

    output.system.push(getSerenaNavigationPrompt())
  }
}
