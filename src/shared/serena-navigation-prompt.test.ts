/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"

const { appendSerenaNavigationPrompt, applySerenaNavigationPrompt, getSerenaNavigationPrompt } = await import("./serena-navigation-prompt")

describe("serena navigation prompt", () => {
  test("appends reminder to existing prompt", () => {
    const result = appendSerenaNavigationPrompt("Base prompt")

    expect(result).toContain("Base prompt")
    expect(result).toContain("<serena_navigation>")
    expect(result).toContain("use Serena tools first for codebase navigation")
  })

  test("does not duplicate reminder when already present", () => {
    const prompt = "Base prompt\n<serena_navigation>existing</serena_navigation>"

    const result = appendSerenaNavigationPrompt(prompt)

    expect(result).toBe(prompt)
  })

  test("applies reminder to agent config prompt", () => {
    const result = applySerenaNavigationPrompt({
      model: "openai/gpt-5.4",
      prompt: "Agent prompt",
    })

    expect(result.prompt).toContain("Agent prompt")
    expect(result.prompt).toContain("<serena_navigation>")
  })

  test("getSerenaNavigationPrompt returns the prompt text", () => {
    const result = getSerenaNavigationPrompt()

    expect(result).toContain("<serena_navigation>")
  })

  test("appendSerenaNavigationPrompt returns empty string for undefined prompt", () => {
    const result = appendSerenaNavigationPrompt(undefined)

    expect(result).toContain("<serena_navigation>")
  })
})
