/// <reference types="bun-types" />

import { describe, expect, mock, test } from "bun:test"

const isSerenaServerAvailableMock = mock(() => true)

mock.module("./serena-availability", () => ({
  isSerenaServerAvailable: isSerenaServerAvailableMock,
}))

const { appendSerenaNavigationPrompt, applySerenaNavigationPrompt, getSerenaNavigationPrompt } = await import("./serena-navigation-prompt")

describe("serena navigation prompt", () => {
  describe("#when serena is available", () => {
    test("appends reminder to existing prompt", () => {
      isSerenaServerAvailableMock.mockReturnValue(true)

      const result = appendSerenaNavigationPrompt("Base prompt")

      expect(result).toContain("Base prompt")
      expect(result).toContain("<serena_navigation>")
      expect(result).toContain("use Serena tools first for codebase navigation")
    })

    test("does not duplicate reminder when already present", () => {
      isSerenaServerAvailableMock.mockReturnValue(true)
      const prompt = "Base prompt\n<serena_navigation>existing</serena_navigation>"

      const result = appendSerenaNavigationPrompt(prompt)

      expect(result).toBe(prompt)
    })

    test("applies reminder to agent config prompt", () => {
      isSerenaServerAvailableMock.mockReturnValue(true)

      const result = applySerenaNavigationPrompt({
        model: "openai/gpt-5.4",
        prompt: "Agent prompt",
      })

      expect(result.prompt).toContain("Agent prompt")
      expect(result.prompt).toContain("<serena_navigation>")
    })

    test("getSerenaNavigationPrompt returns the prompt text", () => {
      isSerenaServerAvailableMock.mockReturnValue(true)

      const result = getSerenaNavigationPrompt()

      expect(result).toContain("<serena_navigation>")
    })
  })

  describe("#when serena is not available", () => {
    test("appendSerenaNavigationPrompt returns prompt unchanged", () => {
      isSerenaServerAvailableMock.mockReturnValue(false)

      const result = appendSerenaNavigationPrompt("Base prompt")

      expect(result).toBe("Base prompt")
      expect(result).not.toContain("<serena_navigation>")
    })

    test("appendSerenaNavigationPrompt returns empty string for undefined prompt", () => {
      isSerenaServerAvailableMock.mockReturnValue(false)

      const result = appendSerenaNavigationPrompt(undefined)

      expect(result).toBe("")
    })

    test("applySerenaNavigationPrompt returns config unchanged", () => {
      isSerenaServerAvailableMock.mockReturnValue(false)

      const config = { model: "openai/gpt-5.4", prompt: "Agent prompt" }
      const result = applySerenaNavigationPrompt(config)

      expect(result).toBe(config)
      expect(result.prompt).toBe("Agent prompt")
    })

    test("getSerenaNavigationPrompt returns empty string", () => {
      isSerenaServerAvailableMock.mockReturnValue(false)

      const result = getSerenaNavigationPrompt()

      expect(result).toBe("")
    })
  })
})
