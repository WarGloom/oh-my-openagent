import type { PluginInput } from "@opencode-ai/plugin"
import type { TeamModeConfig } from "../config/schema/team-mode"

type SdkSession = PluginInput["client"]["session"]
type SdkPromptAsync = SdkSession["promptAsync"]
type SdkStatus = SdkSession["status"]
type SdkMessages = SdkSession["messages"]
type NativeTeamMailbox = (input: {
  readonly teamRunId: string
  readonly memberName: string
  readonly sessionID: string
  readonly config: TeamModeConfig
}) => Promise<readonly string[]>

export type TeamIdleWakeHintNarrowClient = {
  session: {
    promptAsync?: SdkPromptAsync
    status?: SdkStatus
    messages?: SdkMessages
    nativeTeamMailbox?: NativeTeamMailbox
  }
}

export function buildTeamIdleWakeHintClient(
  client: PluginInput["client"] & { readonly session: { readonly nativeTeamMailbox?: NativeTeamMailbox } },
): TeamIdleWakeHintNarrowClient {
  const session = client.session
  const promptAsync =
    typeof session.promptAsync === "function" ? (session.promptAsync.bind(session) as SdkPromptAsync) : undefined
  const status = typeof session.status === "function" ? (session.status.bind(session) as SdkStatus) : undefined
  const messages = typeof session.messages === "function" ? (session.messages.bind(session) as SdkMessages) : undefined
  return {
    session: {
      promptAsync,
      status,
      messages,
      ...(session.nativeTeamMailbox ? { nativeTeamMailbox: session.nativeTeamMailbox.bind(session) } : {}),
    },
  }
}
