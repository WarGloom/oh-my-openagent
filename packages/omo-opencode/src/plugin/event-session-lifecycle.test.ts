/// <reference path="../../../../bun-test.d.ts" />

import { afterEach, describe, expect, test } from "bun:test"
import { _resetForTesting, getSessionAgent } from "../features/claude-code-session-state"
import { clearSessionModel, getStoredSessionModel } from "../shared/session-model-state"
import { handleMessageUpdatedSessionState } from "./event-session-lifecycle"

describe("handleMessageUpdatedSessionState", () => {
  afterEach(() => {
    _resetForTesting()
    clearSessionModel("ses_variant_event")
  })

  test("preserves top-level message variant in tracked session model state", () => {
    //#given
    const notedModels: Array<{ readonly providerID: string; readonly modelID: string }> = []

    //#when
    handleMessageUpdatedSessionState({
      props: {
        info: {
          sessionID: "ses_variant_event",
          role: "user",
          agent: "Prometheus - Plan Builder",
          providerID: "anthropic",
          modelID: "claude-opus-4-8",
          variant: "max",
        },
      },
      noteSessionModel: (_sessionID, model) => {
        notedModels.push(model)
      },
    })

    //#then
    expect(notedModels).toEqual([{ providerID: "anthropic", modelID: "claude-opus-4-8" }])
    expect(getStoredSessionModel("ses_variant_event")).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-4-8",
      variant: "max",
      agent: "Prometheus - Plan Builder",
    })
    expect(getSessionAgent("ses_variant_event")).toBe("Prometheus - Plan Builder")
  })
})
