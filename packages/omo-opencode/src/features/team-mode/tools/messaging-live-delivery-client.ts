import type { TeamModeConfig } from "../../../config/schema/team-mode"

export type LiveDeliveryClient = {
  session: {
    promptAsync(input: {
      path: { id: string }
      body: {
        parts: Array<{ type: "text"; text: string }>
        agent?: string
        model?: { providerID: string; modelID: string }
        variant?: string
      }
      query?: { directory: string }
    }): Promise<unknown>
    status?: () => Promise<unknown>
    nativeTeamMailbox?: (input: { readonly teamRunId: string; readonly memberName: string; readonly sessionID: string; readonly config: TeamModeConfig }) => Promise<readonly string[]>
  }
}
