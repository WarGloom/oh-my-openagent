import { createInternalAgentTextPart, getAgentToolRestrictions } from "../../../shared"
import type { BackgroundTaskUserPermission, LaunchInput } from "../types"

type PromptModel = LaunchInput["model"]

type TaskPromptBodyOptions =
  | {
      readonly kind: "launch"
      readonly agent: string
      readonly model: PromptModel
      readonly system: LaunchInput["skillContent"]
      readonly prompt: string
      readonly includeTeamToolDenylist: boolean
      readonly userPermission?: BackgroundTaskUserPermission
    }
  | {
      readonly kind: "resume"
      readonly agent: string
      readonly model: PromptModel
      readonly prompt: string
      readonly system?: string
      readonly includeTeamToolDenylist: boolean
      readonly userPermission?: BackgroundTaskUserPermission
    }

export type TaskPromptBody = {
  readonly agent: string
  readonly model?: {
    readonly providerID: string
    readonly modelID: string
  }
  readonly variant?: string
  readonly system?: string | undefined
  readonly tools: Record<string, boolean>
  readonly parts: Array<{
    readonly type: "text"
    readonly text: string
    readonly synthetic?: boolean
  }>
}

export function cloneBackgroundTaskUserPermission(
  userPermission: LaunchInput["userPermission"],
): BackgroundTaskUserPermission | undefined {
  if (!userPermission) return undefined
  return Object.freeze({ ...userPermission })
}

export function buildBackgroundTaskPromptTools(options: {
  readonly agent: string
  readonly includeTeamToolDenylist: boolean
  readonly userPermission?: BackgroundTaskUserPermission
}): Record<string, boolean> {
  const userDenied: Record<string, boolean> = {}
  if (options.userPermission) {
    for (const [tool, value] of Object.entries(options.userPermission)) {
      if (value === "deny") userDenied[tool] = false
    }
  }

  return {
    task: false,
    call_omo_agent: true,
    question: false,
    ...userDenied,
    ...getAgentToolRestrictions(options.agent, {
      includeTeamToolDenylist: options.includeTeamToolDenylist,
    }),
  }
}

export function buildTaskPromptBody(options: TaskPromptBodyOptions): TaskPromptBody {
  const promptModel = options.model
    ? {
        providerID: options.model.providerID,
        modelID: options.model.modelID,
      }
    : undefined
  const promptVariant = options.model?.variant

  return {
    agent: options.agent,
    ...(promptModel ? { model: promptModel } : {}),
    ...(promptVariant ? { variant: promptVariant } : {}),
    ...(options.system !== undefined ? { system: options.system } : {}),
    tools: buildBackgroundTaskPromptTools(options),
    parts: [createInternalAgentTextPart(options.prompt)],
  }
}
