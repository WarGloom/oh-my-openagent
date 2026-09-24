import { describe, expect, test } from "bun:test"
import { clearSessionModel, getLiveParentPromptSelection, getSessionModel, getStoredSessionModel, setSessionModel } from "./session-model-state"
import { clearSessionAgent, setSessionAgent } from "../features/claude-code-session-state/state"

describe("session-model-state", () => {
  test("live parent selection falls back to the session agent when stored model has no agent", () => {
    // given
    const sessionID = "ses_agent_fallback"
    setSessionAgent(sessionID, "agent-b")
    setSessionModel(sessionID, { providerID: "provider-b", modelID: "model-b", variant: "variant-b" })

    // when
    const selection = getLiveParentPromptSelection(sessionID)

    // then
    expect(selection).toEqual({ model: { providerID: "provider-b", modelID: "model-b" }, variant: "variant-b", agent: "agent-b" })
    clearSessionAgent(sessionID)
    clearSessionModel(sessionID)
  })

  test("stores and retrieves a session model", () => {
    //#given
    const sessionID = "ses_test"

    //#when
    setSessionModel(sessionID, { providerID: "github-copilot", modelID: "gpt-4.1" })

    //#then
    expect(getSessionModel(sessionID)).toEqual({
      providerID: "github-copilot",
      modelID: "gpt-4.1",
    })
  })

  test("keeps variant metadata in stored state while public model identity stays variant-free", () => {
    //#given
    const sessionID = "ses_variant"

    //#when
    setSessionModel(sessionID, {
      providerID: "anthropic",
      modelID: "claude-opus-4-8",
      variant: "max",
    })

    //#then
    expect(getSessionModel(sessionID)).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-4-8",
    })
    expect(getStoredSessionModel(sessionID)).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-4-8",
      variant: "max",
    })
  })

  test("keeps agent ownership metadata out of the public session model", () => {
    //#given
    const sessionID = "ses_owned"

    //#when
    setSessionModel(sessionID, { providerID: "openai", modelID: "gpt-5.4" }, "sisyphus")

    //#then
    expect(getSessionModel(sessionID)).toEqual({
      providerID: "openai",
      modelID: "gpt-5.4",
    })
    expect(getStoredSessionModel(sessionID)).toEqual({
      providerID: "openai",
      modelID: "gpt-5.4",
      agent: "sisyphus",
    })
  })

  test("clears a session model", () => {
    //#given
    const sessionID = "ses_clear"
    setSessionModel(sessionID, { providerID: "anthropic", modelID: "gpt-5.5" })

    //#when
    clearSessionModel(sessionID)

    //#then
    expect(getSessionModel(sessionID)).toBeUndefined()
  })
})
