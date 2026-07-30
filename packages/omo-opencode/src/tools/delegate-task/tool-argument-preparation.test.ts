import { describe, expect, test } from "bun:test"

import { OMO_INTERNAL_INITIATOR_MARKER } from "../../shared/internal-initiator-marker"
import { prepareDelegateTaskArgs } from "./tool-argument-preparation"
import type { ToolContextWithMetadata } from "./types"

function createToolContext(metadataCalls: Array<{ title?: string; metadata?: Record<string, unknown> }>): ToolContextWithMetadata {
  return {
    sessionID: "ses_parent",
    messageID: "msg_parent",
    agent: "sisyphus",
    abort: new AbortController().signal,
    metadata: (input) => {
      metadataCalls.push(input)
    },
  }
}

describe("prepareDelegateTaskArgs", () => {
  test("#given internal plan prompt #when preparing Momus delegation #then marker is stripped before child session metadata", async () => {
    // given
    const metadataCalls: Array<{ title?: string; metadata?: Record<string, unknown> }> = []
    const args: Record<string, unknown> = {
      prompt: `.omo/plans/langfuse-implementation.md\n${OMO_INTERNAL_INITIATOR_MARKER}`,
      subagent_type: "momus",
      run_in_background: false,
    }

    // when
    const result = await prepareDelegateTaskArgs(args, createToolContext(metadataCalls))

    // then
    expect(result.prompt).toBe(".omo/plans/langfuse-implementation.md")
    expect(result.description).toBe(".omo/plans/langfuse-implementation.md")
    expect(args.prompt).toBe(".omo/plans/langfuse-implementation.md")
    expect(args.description).toBe(".omo/plans/langfuse-implementation.md")
    expect(metadataCalls).toEqual([{ title: ".omo/plans/langfuse-implementation.md" }])
  })
})
