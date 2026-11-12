import type { BackgroundTask } from "../features/background-agent/types"
import {
  ExecutorRequirementError,
  assertRequiredModel,
  requiredModelFromMetadata,
} from "../shared/delegated-executor-requirement"
import type { V2PluginContext } from "./context-types"

export async function enforceNativeExecutorRequirement(context: V2PluginContext, task: BackgroundTask): Promise<void> {
  const required = requiredModelFromMetadata(task.nativeMetadata)
  if (required === undefined) return
  if (!task.sessionId) throw new ExecutorRequirementError("unsupported_execution")
  const session = await context.session.get({ sessionID: task.sessionId })
  if (session.parentID !== task.parentSessionId || session.agent !== task.agent)
    throw new ExecutorRequirementError("agent_conflict")
  assertRequiredModel(required, session.model && `${session.model.providerID}/${session.model.id}`)
}

export function bindNativeExecutorRequirements(
  context: V2PluginContext,
  load: (sessionID: string, parentSessionID: string) => Promise<BackgroundTask | undefined>,
): V2PluginContext {
  const requiredModel = async (sessionID: string): Promise<string | undefined> => {
    const session = await context.session.get({ sessionID })
    if (!session.parentID) return undefined
    const task = await load(sessionID, session.parentID)
    if (!task) return undefined
    await enforceNativeExecutorRequirement(context, task)
    return requiredModelFromMetadata(task.nativeMetadata)
  }
  return {
    ...context,
    session: {
      ...context.session,
      switchModel: async (input) => {
        assertRequiredModel(await requiredModel(input.sessionID), `${input.model.providerID}/${input.model.id}`)
        return context.session.switchModel(input)
      },
    },
    experimental: {
      ...context.experimental,
      session: {
        ...context.experimental.session,
        continueAfterFailure: async (input) => {
          const required = await requiredModel(input.sessionID)
          if (input.model) assertRequiredModel(required, `${input.model.providerID}/${input.model.id}`)
          return context.experimental.session.continueAfterFailure(input)
        },
      },
    },
  }
}
