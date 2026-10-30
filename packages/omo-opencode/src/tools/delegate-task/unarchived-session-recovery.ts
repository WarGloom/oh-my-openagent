import { z } from "zod"
import type { BackgroundTask } from "../../features/background-agent/types"
import { MISSING_RETAINED_TASK_ERROR } from "../../features/background-agent/task-registry"
import { normalizeSDKResponse } from "../../shared"
import type { ParentContext } from "./executor-types"
import type { OpencodeClient } from "./types"

const userMessageInfo = z.object({
  role: z.literal("user"),
  agent: z.string().min(1),
  model: z.object({ providerID: z.string().min(1), modelID: z.string().min(1), variant: z.string().min(1).optional() }),
})

/**
 * Rebuilds the record of a finished child session that the in-memory archive no longer holds,
 * for example after an OpenCode restart. Agent and model come from the latest user message that
 * OpenCode itself recorded for the session, so the continuation keeps the original agent.
 */
export async function recoverUnarchivedTask(
  client: OpencodeClient,
  sessionID: string,
  parentContext: ParentContext,
  title: string | undefined,
): Promise<BackgroundTask> {
  const messages = normalizeSDKResponse(
    await client.session.messages({ path: { id: sessionID } }),
    [] as Array<{ info?: unknown }>,
  )
  for (let index = messages.length - 1; index >= 0; index--) {
    const info = userMessageInfo.safeParse(messages[index]?.info)
    if (!info.success) continue
    const { agent, model } = info.data
    return {
      id: `bg_${crypto.randomUUID().slice(0, 8)}`,
      sessionId: sessionID,
      parentSessionId: parentContext.sessionID,
      parentMessageId: parentContext.messageID,
      parentAgent: parentContext.agent,
      description: title?.trim() || `Recovered session ${sessionID}`,
      prompt: "[redacted]",
      agent,
      model,
      status: "completed",
      completedAt: new Date(),
      concurrencyGroup: `${model.providerID}/${model.modelID}`,
    }
  }
  throw new Error(`${MISSING_RETAINED_TASK_ERROR} The session has no user message with agent and model metadata.`)
}
