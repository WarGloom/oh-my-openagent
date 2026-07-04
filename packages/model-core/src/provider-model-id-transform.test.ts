import { describe, expect, test } from "bun:test"

import {
	transformModelForProvider,
	transformModelForProviderDisplay,
} from "./provider-model-id-transform"

describe("provider model ID transforms", () => {
	test("preserves hyphenated Anthropic IDs for direct API calls", () => {
		// #given Anthropic model IDs in config-display form
		const provider = "anthropic"
		const models = ["claude-haiku-4-5", "claude-opus-4-7"] as const

		for (const model of models) {
			// #when both model-core transform variants are called
			const apiResult = transformModelForProvider(provider, model)
			const displayResult = transformModelForProviderDisplay(provider, model)

			// #then direct Anthropic calls keep the strict provider model ID
			expect(apiResult).toBe(model)
			expect(displayResult).toBe(model)
		}
	})

	test("keeps dotted Claude versions for gateway providers", () => {
		// #given gateway providers that expect Claude version aliases
		const scenarios = [
			{
				provider: "github-copilot",
				model: "claude-haiku-4-5",
				expected: "claude-haiku-4.5",
			},
			{
				provider: "github-copilot",
				model: "claude-opus-4-7",
				expected: "claude-opus-4.7",
			},
			{
				provider: "vercel",
				model: "claude-haiku-4-5",
				expected: "anthropic/claude-haiku-4.5",
			},
			{
				provider: "vercel",
				model: "anthropic/claude-opus-4-7",
				expected: "anthropic/claude-opus-4.7",
			},
		] as const

		for (const scenario of scenarios) {
			// #when a gateway transform is applied
			const result = transformModelForProvider(scenario.provider, scenario.model)

			// #then the gateway receives its dotted Claude version form
			expect(result).toBe(scenario.expected)
		}
	})

	test("normalizes dotted Anthropic aliases back to native hyphenated IDs", () => {
		// #given an Anthropic model ID accidentally normalized into Copilot-style dotted form
		const provider = "anthropic"
		const model = "claude-haiku-4.5"

		// #when both model-core transform variants are called
		const apiResult = transformModelForProvider(provider, model)
		const displayResult = transformModelForProviderDisplay(provider, model)

		// #then Anthropic keeps its native hyphenated model ID
		expect(apiResult).toBe("claude-haiku-4-5")
		expect(displayResult).toBe("claude-haiku-4-5")
	})

	test("produces identical results for non-Anthropic providers", () => {
		// #given non-Anthropic provider/model pairs
		const scenarios = [
			{ provider: "openai", model: "gpt-4o" },
			{ provider: "google", model: "gemini-2.5-pro" },
			{ provider: "github-copilot", model: "gemini-3-flash" },
			{ provider: "vercel", model: "claude-opus-4-7" },
		] as const

		for (const scenario of scenarios) {
			// #when both transform variants are called
			const apiResult = transformModelForProvider(
				scenario.provider,
				scenario.model,
			)
			const displayResult = transformModelForProviderDisplay(
				scenario.provider,
				scenario.model,
			)

			// #then the variants match outside the direct Anthropic provider branch
			expect(displayResult).toBe(apiResult)
		}
	})
})
