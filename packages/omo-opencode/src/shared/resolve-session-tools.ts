import type { PromptToolPermission } from "./prompt-tools"

import { normalizeSDKResponse } from "./normalize-sdk-response"
import { normalizePromptTools } from "./prompt-tools"
import { getSessionTools, setSessionTools } from "./session-tools-store"

type SessionToolsClient = {
  session: {
    messages: (input: { path: { id: string } }) => Promise<unknown>
  }
}

type SessionMessage = {
  info?: {
    tools?: Record<string, PromptToolPermission>
  }
}

export async function resolveSessionTools(
  client: SessionToolsClient,
  sessionID: string,
): Promise<Record<string, boolean> | undefined> {
  const storedTools = getSessionTools(sessionID)
  if (storedTools) {
    return storedTools
  }

  try {
    const response = await client.session.messages({ path: { id: sessionID } })
    const messages = normalizeSDKResponse(response, [] as SessionMessage[], {
      preferResponseOnMissingData: true,
    })

    for (let index = messages.length - 1; index >= 0; index--) {
      const tools = normalizePromptTools(messages[index]?.info?.tools)
      if (tools) {
        setSessionTools(sessionID, tools)
        return tools
      }
    }
  } catch {
    return undefined
  }

  return undefined
}
