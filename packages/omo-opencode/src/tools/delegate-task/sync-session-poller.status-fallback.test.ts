/// <reference types="bun-types" />
import { afterEach, describe, expect, test } from "bun:test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { pollSyncSession } from "./sync-session-poller"
import { __resetTimingConfig, __setTimingConfig } from "./timing"
import type { OpencodeClient, ToolContextWithMetadata } from "./types"

const toolContext: ToolContextWithMetadata = {
  sessionID: "ses_parent",
  messageID: "msg_parent",
  agent: "sisyphus",
  abort: new AbortController().signal,
}

describe("pollSyncSession status fallback", () => {
  afterEach(() => {
    __resetTimingConfig()
  })

  test("#given status API is unavailable but terminal assistant finish exists #when polling #then messages complete the sync task", async () => {
    // given
    __setTimingConfig({
      POLL_INTERVAL_MS: 1,
      MAX_POLL_TIME_MS: 50,
    })
    const client = unsafeTestValue<OpencodeClient>({
      session: {
        messages: async () => ({
          data: [
            { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
            {
              info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: "stop" },
              parts: [{ type: "text", text: "done" }],
            },
          ],
        }),
        abort: async () => ({ data: {} }),
      },
    })

    // when
    const result = await pollSyncSession(toolContext, client, {
      sessionID: "ses_missing_status",
      agentToUse: "sisyphus",
      toastManager: null,
      taskId: undefined,
    }, 50)

    // then
    expect(result).toBeNull()
  })

  test("#given stale assistant text and latest unfinished assistant turn #when polling #then sync task stays incomplete", async () => {
    // given
    __setTimingConfig({
      POLL_INTERVAL_MS: 1,
      MAX_POLL_TIME_MS: 50,
    })
    const client = unsafeTestValue<OpencodeClient>({
      session: {
        messages: async () => ({
          data: [
            { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
            {
              info: { id: "msg_002", role: "assistant", time: { created: 2000 }, finish: "stop" },
              parts: [{ type: "text", text: "old done" }],
            },
            {
              info: { id: "msg_003", role: "assistant", time: { created: 3000 } },
              parts: [],
            },
          ],
        }),
        abort: async () => ({ data: {} }),
      },
    })

    // when
    const result = await pollSyncSession(toolContext, client, {
      sessionID: "ses_latest_unfinished",
      agentToUse: "sisyphus",
      toastManager: null,
      taskId: undefined,
    }, 50)

    // then
    expect(result).toBe(
      "Poll inactivity timeout reached after 50ms without active OpenCode status for session ses_latest_unfinished",
    )
  })

  test("#given missing status and unchanged nonterminal messages #when polling #then short no-progress timeout wins", async () => {
    // given
    __setTimingConfig({
      POLL_INTERVAL_MS: 1,
      MAX_POLL_TIME_MS: 5_000,
    })
    let abortCount = 0
    const client = unsafeTestValue<OpencodeClient>({
      session: {
        messages: async () => ({
          data: [{ info: { id: "msg_001", role: "user", time: { created: 1000 } } }],
        }),
        status: async () => ({ data: {} }),
        abort: async () => {
          abortCount++
          return { data: {} }
        },
      },
    })

    // when
    const result = await pollSyncSession(toolContext, client, {
      sessionID: "ses_missing_status_stalled",
      agentToUse: "sisyphus",
      toastManager: null,
      taskId: undefined,
      activeNoProgressTimeoutMs: 50,
    }, 5_000)

    // then
    expect(result).toBe(
      "Poll no-progress timeout reached after 50ms without message or part progress while OpenCode status was unavailable for session ses_missing_status_stalled",
    )
    expect(abortCount).toBe(1)
  })
})
