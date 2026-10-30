/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test"
import { clearSessionModel, setSessionModel } from "../../shared/session-model-state"
import { buildRecipientPromptBody } from "./member-session-routing"
import type { RuntimeStateMember } from "./types"

const leadSessionID = "ses_lead_recipient_variant"

function member(overrides: Partial<RuntimeStateMember> = {}): RuntimeStateMember {
  return {
    name: "lead",
    agentType: "leader",
    subagent_type: "orchestrator",
    status: "running",
    pendingInjectedMessageIds: [],
    ...overrides,
  }
}

afterEach(() => {
  clearSessionModel(leadSessionID)
})

describe("buildRecipientPromptBody", () => {
  test("#given a lead without a member model #when a peer message is delivered #then the lead session model and variant are kept", () => {
    // given
    setSessionModel(
      leadSessionID,
      { providerID: "anthropic", modelID: "claude-opus-5-5", variant: "xhigh" },
      "orchestrator",
    )

    // when
    const body = buildRecipientPromptBody(leadSessionID, member(), "peer message")

    // then
    expect(body.model).toEqual({ providerID: "anthropic", modelID: "claude-opus-5-5" })
    expect(body.variant).toBe("xhigh")
  })

  test("#given a member with its own model #when a message is delivered #then the member model wins over the session model", () => {
    // given
    setSessionModel(leadSessionID, { providerID: "anthropic", modelID: "claude-opus-5-5", variant: "xhigh" })

    // when
    const body = buildRecipientPromptBody(
      leadSessionID,
      member({ model: { providerID: "openai", modelID: "gpt-5", variant: "low" } }),
      "task",
    )

    // then
    expect(body.model).toEqual({ providerID: "openai", modelID: "gpt-5" })
    expect(body.variant).toBe("low")
  })
})
