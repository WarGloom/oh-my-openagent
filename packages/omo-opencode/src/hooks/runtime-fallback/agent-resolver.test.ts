/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"

import { normalizeAgentName, resolveAgentForSession } from "./agent-resolver"

describe("normalizeAgentName", () => {
  test("returns canonical lowercase key for built-in agents", () => {
    // given/when/then
    expect(normalizeAgentName("sisyphus")).toBe("sisyphus")
    expect(normalizeAgentName("Hephaestus")).toBe("hephaestus")
    expect(normalizeAgentName("SISYPHUS-JUNIOR")).toBe("sisyphus-junior")
  })

  test("resolves display name to config key for built-in agents via pattern", () => {
    // given a display name that contains a known built-in agent name
    expect(normalizeAgentName("Sisyphus - ultraworker")).toBe("sisyphus")
    expect(normalizeAgentName("Metis - Plan Consultant")).toBe("metis")
  })

  test("passes through project-defined agent names so their fallback chains resolve", () => {
    // given a project-defined agent name that is not in AGENT_NAMES
    // when normalizeAgentName is called
    // then it returns the lowercased name so pluginConfig.agents[name] lookup succeeds
    expect(normalizeAgentName("secmvp-worker-host")).toBe("secmvp-worker-host")
    expect(normalizeAgentName("secmvp-rust-dev")).toBe("secmvp-rust-dev")
    expect(normalizeAgentName("my-custom-agent")).toBe("my-custom-agent")
  })

  test("returns undefined for empty / whitespace-only input", () => {
    expect(normalizeAgentName(undefined)).toBeUndefined()
    expect(normalizeAgentName("")).toBeUndefined()
  })
})

describe("resolveAgentForSession", () => {
  test("returns project-defined agent name from eventAgent", () => {
    // given a project-defined agent name passed as the event agent
    // when resolving
    // then the exact name is returned (not undefined), enabling pluginConfig.agents lookup
    const result = resolveAgentForSession("ses_some-session-id", "secmvp-worker-host")
    expect(result).toBe("secmvp-worker-host")
  })
})
