import type { TeamModeConfig } from "../../../config/schema/team-mode"

export type NativeTeamMailboxInput = {
  readonly teamRunId: string
  readonly memberName: string
  readonly sessionID: string
  readonly config: TeamModeConfig
  readonly source?: "live" | "idle"
}

export type NativeTeamMailbox = (input: NativeTeamMailboxInput) => Promise<readonly string[]>

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
    nativeTeamMailbox?: NativeTeamMailbox
  }
}
