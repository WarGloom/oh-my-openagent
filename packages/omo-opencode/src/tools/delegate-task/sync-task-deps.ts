import { isProviderExhaustionFallbackEligible } from "@oh-my-opencode/model-core"
import { createSyncSession } from "./sync-session-creator"
import { sendSyncPrompt } from "./sync-prompt-sender"
import { pollSyncSession } from "./sync-session-poller"
import { fetchSyncResult } from "./sync-result-fetcher"
import { normalizeSDKResponse } from "../../shared"

type SyncMessagesClient = {
  readonly session: {
    readonly messages: (input: { path: { id: string } }) => Promise<unknown>
  }
}

export async function getSyncMessageCount(
  client: SyncMessagesClient,
  sessionID: string,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const messagesResponse = await client.session.messages({ path: { id: sessionID } })

  if (
    typeof messagesResponse === "object"
    && messagesResponse !== null
    && "error" in messagesResponse
    && messagesResponse.error
  ) {
    return {
      ok: false,
      error: `Error fetching fallback anchor: ${String(messagesResponse.error)}\n\nSession ID: ${sessionID}`,
    }
  }

  const messages = normalizeSDKResponse<unknown>(messagesResponse, undefined, {
    preferResponseOnMissingData: true,
  })
  if (!Array.isArray(messages)) {
    return {
      ok: false,
      error: `Invalid fallback anchor response: expected a message array.\n\nSession ID: ${sessionID}`,
    }
  }

  return { ok: true, count: messages.length }
}

export type SyncTaskDeps = {
  readonly createSyncSession: typeof createSyncSession
  readonly sendSyncPrompt: typeof sendSyncPrompt
  readonly pollSyncSession: typeof pollSyncSession
  readonly fetchSyncResult: typeof fetchSyncResult
  readonly getSyncMessageCount?: typeof getSyncMessageCount
  readonly isProviderExhaustionFallbackEligible?: typeof isProviderExhaustionFallbackEligible
}

export const syncTaskDeps: SyncTaskDeps = {
  createSyncSession,
  sendSyncPrompt,
  pollSyncSession,
  fetchSyncResult,
  getSyncMessageCount,
  isProviderExhaustionFallbackEligible,
}
