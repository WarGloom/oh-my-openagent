/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"
import { getSyncMessageCount } from "./sync-task-deps"

describe("getSyncMessageCount", () => {
  test("#given an SDK error response #when fetching a fallback anchor #then it rejects the anchor", async () => {
    //#given
    const client = {
      session: {
        messages: async () => ({ error: "sdk unavailable", data: undefined }),
      },
    }

    //#when
    const result = await getSyncMessageCount(client, "ses_anchor_error")

    //#then
    expect(result).toEqual({
      ok: false,
      error: "Error fetching fallback anchor: sdk unavailable\n\nSession ID: ses_anchor_error",
    })
  })

  test("#given a non-array SDK payload #when fetching a fallback anchor #then it rejects the anchor", async () => {
    //#given
    const client = {
      session: {
        messages: async () => ({ data: { id: "not-a-message-list" } }),
      },
    }

    //#when
    const result = await getSyncMessageCount(client, "ses_anchor_payload")

    //#then
    expect(result).toEqual({
      ok: false,
      error: "Invalid fallback anchor response: expected a message array.\n\nSession ID: ses_anchor_payload",
    })
  })
})
