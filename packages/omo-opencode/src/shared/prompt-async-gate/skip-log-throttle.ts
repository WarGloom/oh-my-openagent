/** Default window after which a still-identical skip reason may be logged again,
 *  so a permanently-active session does not silently hide a starved queue. */
export const DEFAULT_PROMPT_SKIP_LOG_HEARTBEAT_MS = 30_000

const NULL = "\u0000"

const skipLogTimestamps = new Map<string, Map<string, number>>()

function entryKey(sessionID: string, dedupeKey: string): string {
  return `${sessionID}${NULL}${dedupeKey}`
}

export function shouldLogPromptSkip(
  sessionID: string,
  dedupeKey: string,
  status: string,
  heartbeatMs: number = DEFAULT_PROMPT_SKIP_LOG_HEARTBEAT_MS,
): boolean {
  const key = entryKey(sessionID, dedupeKey)
  const now = Date.now()
  const statuses = skipLogTimestamps.get(key)

  if (!statuses) {
    skipLogTimestamps.set(key, new Map([[status, now]]))
    return true
  }

  const lastLoggedAt = statuses.get(status)
  if (lastLoggedAt !== undefined && now - lastLoggedAt < heartbeatMs) {
    return false
  }

  statuses.set(status, now)
  return true
}

export function clearPromptSkipLogState(sessionID: string, dedupeKey: string): void {
  skipLogTimestamps.delete(entryKey(sessionID, dedupeKey))
}

export function clearPromptSkipLogStateForTesting(): void {
  skipLogTimestamps.clear()
}
