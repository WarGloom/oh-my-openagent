import type { PluginInput } from "@opencode-ai/plugin"

import { isSyntheticOrInternalUserMessage, normalizeSDKResponse } from "../../shared"
import { isCompactionMessage } from "../../shared/compaction-marker"

import type { MessageWithInfo, ResolveLatestMessageInfoResult } from "./types"

export async function resolveLatestMessageInfo(
  ctx: PluginInput,
  sessionID: string,
  prefetchedMessages?: MessageWithInfo[]
): Promise<ResolveLatestMessageInfoResult> {
  const messages = prefetchedMessages ?? normalizeSDKResponse(
    await ctx.client.session.messages({
      path: { id: sessionID },
    }),
    [] as MessageWithInfo[],
  )
  let encounteredCompaction = false
  let latestMessageWasCompaction = false

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    const info = message.info
    const isCompaction = isCompactionMessage(message)
    if (i === messages.length - 1) {
      latestMessageWasCompaction = isCompaction
    }

    if (isCompaction) {
      encounteredCompaction = true
      continue
    }
    if (isSyntheticOrInternalUserMessage(message)) {
      continue
    }
    if (!info) {
      continue
    }
    const model = info?.model ?? (info?.providerID && info?.modelID ? { providerID: info.providerID, modelID: info.modelID } : undefined)
    const suppressModel = Boolean(model) && (Boolean(info?.error) || info?.runtimeFallbackModelOverride === true)
    if (info?.agent || model) {
      return {
        resolvedInfo: {
          agent: info.agent,
          model: suppressModel ? undefined : model,
          ...(suppressModel ? { modelSuppressed: true } : {}),
          tools: info.tools,
        },
        encounteredCompaction,
        latestMessageWasCompaction,
      }
    }
  }

  return { resolvedInfo: undefined, encounteredCompaction, latestMessageWasCompaction }
}
