import type { OpencodeClient } from "@opencode-ai/sdk"
import { normalizeSDKResponse } from "../../shared"
import { traceRunStep } from "./run-debug"

const AGENT_PROFILE_COLORS_TIMEOUT_MS = 5_000

interface AgentProfile {
  name?: string
  color?: string
}

export async function loadAgentProfileColors(
  client: OpencodeClient,
): Promise<Record<string, string>> {
  try {
    const agentsRes = await traceRunStep("loadAgentProfileColors", async () => {
      let timeout: ReturnType<typeof setTimeout> | null = null

      const result = await Promise.race([
        client.app.agents(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error("Timed out while loading agent profiles"))
          }, AGENT_PROFILE_COLORS_TIMEOUT_MS)
          timeout.unref?.()
        }),
      ])

      if (timeout) clearTimeout(timeout)
      return result
    })

    const agents = normalizeSDKResponse(agentsRes, [] as AgentProfile[], {
      preferResponseOnMissingData: true,
    })

    const colors: Record<string, string> = {}
    for (const agent of agents) {
      if (!agent.name || !agent.color) continue
      colors[agent.name] = agent.color
    }

    return colors
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error
    }
    return {}
  }
}
