declare const require: (name: string) => any
const { describe, test, expect, beforeEach, afterEach, spyOn, mock } = require("bun:test")
import { resolveCategoryExecution } from "./category-resolver"
import { applyCategoryParams } from "./delegated-model-config"
import type { DelegatedModelConfig } from "./types"
import type { CategoryConfig } from "../../config/schema"
import type { ExecutorContext } from "./executor-types"
import * as connectedProvidersCache from "../../shared/connected-providers-cache"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"

describe("resolveCategoryExecution", () => {
	let connectedProvidersSpy: ReturnType<typeof spyOn> | undefined
	let providerModelsSpy: ReturnType<typeof spyOn> | undefined
	let hasConnectedProvidersSpy: ReturnType<typeof spyOn> | undefined
	let hasProviderModelsSpy: ReturnType<typeof spyOn> | undefined

	beforeEach(() => {
		mock.restore()
		connectedProvidersSpy = spyOn(connectedProvidersCache, "readConnectedProvidersCache").mockReturnValue(null)
		providerModelsSpy = spyOn(connectedProvidersCache, "readProviderModelsCache").mockReturnValue(null)
		hasConnectedProvidersSpy = spyOn(connectedProvidersCache, "hasConnectedProvidersCache").mockReturnValue(false)
		hasProviderModelsSpy = spyOn(connectedProvidersCache, "hasProviderModelsCache").mockReturnValue(false)
	})

	afterEach(() => {
		connectedProvidersSpy?.mockRestore()
		providerModelsSpy?.mockRestore()
		hasConnectedProvidersSpy?.mockRestore()
		hasProviderModelsSpy?.mockRestore()
	})

	const createMockExecutorContext = (): ExecutorContext => ({
		client: unsafeTestValue({}),
		manager: unsafeTestValue({}),
		directory: "/tmp/test",
		userCategories: {},
		sisyphusJuniorModel: undefined,
	})

	test("returns unpinned resolution when category cache is not ready on first run", async () => {
		//#given
		const args = {
			category: "deep",
			prompt: "test prompt",
			description: "Test task",
			run_in_background: false,
			load_skills: [],
			blockedBy: undefined,
			enableSkillTools: false,
		}
		const executorCtx = createMockExecutorContext()
		executorCtx.userCategories = {
			deep: {},
		}
		const inheritedModel = undefined
		const systemDefaultModel = "anthropic/claude-sonnet-4-6"

		//#when
		const result = await resolveCategoryExecution(args, executorCtx, inheritedModel, systemDefaultModel)

		//#then
		expect(result.error).toBeUndefined()
		expect(result.actualModel).toBeUndefined()
		expect(result.categoryModel).toBeUndefined()
		expect(result.agentToUse).toBeDefined()
	})

	test("returns 'unknown category' error for truly unknown categories", async () => {
		//#given
		const args = {
			category: "definitely-not-a-real-category-xyz123",
			prompt: "test prompt",
			description: "Test task",
			run_in_background: false,
			load_skills: [],
			blockedBy: undefined,
			enableSkillTools: false,
		}
		const executorCtx = createMockExecutorContext()
		const inheritedModel = undefined
		const systemDefaultModel = "anthropic/claude-sonnet-4-6"

		//#when
		const result = await resolveCategoryExecution(args, executorCtx, inheritedModel, systemDefaultModel)

		//#then
		expect(result.error).toBeDefined()
		expect(result.error).toContain("Unknown category")
		expect(result.error).toContain("definitely-not-a-real-category-xyz123")
	})

	test("uses category fallback_models for background/runtime fallback chain", async () => {
		//#given
		const args = {
			category: "deep",
			prompt: "test prompt",
			description: "Test task",
			run_in_background: false,
			load_skills: [],
			blockedBy: undefined,
			enableSkillTools: false,
		}
		const executorCtx = createMockExecutorContext()
		executorCtx.userCategories = {
			deep: {
				model: "quotio/claude-opus-4-7",
				fallback_models: ["quotio/kimi-k2.5", "openai/gpt-5.5(high)"],
			},
		}

		//#when
		const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

		//#then
		expect(result.error).toBeUndefined()
		expect(result.fallbackChain).toEqual([
			{ providers: ["quotio"], model: "kimi-k2.5", variant: undefined },
			{ providers: ["openai"], model: "gpt-5.5", variant: "high" },
			{
				providers: ["openai", "github-copilot", "opencode", "vercel"],
				model: "gpt-5.5",
				variant: "medium",
			},
			{
				providers: ["anthropic", "github-copilot", "opencode", "vercel"],
				model: "claude-opus-4-7",
				variant: "max",
			},
			{
				providers: ["google", "github-copilot", "opencode", "vercel"],
				model: "gemini-3.1-pro",
				variant: "high",
			},
			{ providers: ["opencode-go", "vercel"], model: "kimi-k2.6" },
			{ providers: ["opencode-go", "vercel"], model: "glm-5.1" },
		])
	})

	test("keeps built-in GPT fallback when category fallback_models override omits OpenAI", async () => {
		//#given
		const cacheSpy = spyOn(connectedProvidersCache, "readProviderModelsCache").mockReturnValue({
			models: {
				"github-copilot": ["gemini-3.1-pro-preview"],
				openai: ["gpt-5.5"],
				anthropic: ["claude-opus-4-8"],
				opencode: ["qwen3.6-plus", "nemotron-3-super-free"],
			},
			connected: ["github-copilot", "openai", "anthropic", "opencode"],
			updatedAt: "2026-06-01T00:00:00.000Z",
		})
		const agentsSpy = spyOn(connectedProvidersCache, "readConnectedProvidersCache").mockReturnValue([
			"github-copilot",
			"openai",
			"anthropic",
			"opencode",
		])
		const args = {
			category: "artistry",
			prompt: "test prompt",
			description: "Test task",
			run_in_background: true,
			load_skills: [],
			blockedBy: undefined,
			enableSkillTools: false,
		}
		const executorCtx = createMockExecutorContext()
		executorCtx.userCategories = {
			artistry: {
				model: "github-copilot/gemini-3.1-pro-preview",
				variant: "high",
				fallback_models: [
					{ model: "anthropic/claude-opus-4.8", variant: "max" },
					{ model: "opencode/qwen3.6-plus-free", variant: "high" },
					{ model: "github-copilot/claude-opus-4.8", variant: "max" },
					{ model: "opencode/nemotron-3-super-free", variant: "high" },
				],
			},
		}

		//#when
		const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

		//#then
		expect(result.error).toBeUndefined()
		expect(result.actualModel).toBe("github-copilot/gemini-3.1-pro-preview")
		const gptIndex = result.fallbackChain?.findIndex((entry) =>
			entry.providers.includes("openai") && entry.model === "gpt-5.5"
		)
		const freeIndex = result.fallbackChain?.findIndex((entry) =>
			entry.providers.includes("opencode") && entry.model === "qwen3.6-plus-free"
		)
		expect(gptIndex).toBeGreaterThan(-1)
		expect(freeIndex).toBeGreaterThan(-1)
		expect(freeIndex).toBeLessThan(gptIndex ?? Number.POSITIVE_INFINITY)
		cacheSpy.mockRestore()
		agentsSpy.mockRestore()
	})

	test("promotes object-style fallback model settings to categoryModel when fallback becomes initial model", async () => {
		//#given
		const cacheSpy = spyOn(connectedProvidersCache, "readProviderModelsCache").mockReturnValue({
			models: { openai: ["gpt-5.4"] },
			connected: ["openai"],
			updatedAt: "2026-03-03T00:00:00.000Z",
		})
		const agentsSpy = spyOn(connectedProvidersCache, "readConnectedProvidersCache").mockReturnValue(["openai"])
		const args = {
			category: "quick",
			prompt: "test prompt",
			description: "Test task",
			run_in_background: false,
			load_skills: [],
			blockedBy: undefined,
			enableSkillTools: false,
		}
		const executorCtx = createMockExecutorContext()
		executorCtx.userCategories = {
			quick: {
				fallback_models: [
					{
						model: "openai/gpt-5.4 high",
						variant: "low",
						reasoningEffort: "high",
						temperature: 0.4,
						top_p: 0.7,
						maxTokens: 4096,
						thinking: { type: "disabled" },
					},
				],
			},
		}

		//#when
		const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

		//#then
		expect(result.error).toBeUndefined()
		expect(result.actualModel).toBe("openai/gpt-5.4")
		expect(result.categoryModel).toEqual({
			providerID: "openai",
			modelID: "gpt-5.4",
			variant: "low",
			reasoningEffort: "high",
			temperature: 0.4,
			top_p: 0.7,
			maxTokens: 4096,
			thinking: { type: "disabled" },
		})
		cacheSpy.mockRestore()
		agentsSpy.mockRestore()
	})

	test("preserves inline variant from category model string when no explicit variant is configured", async () => {
		//#given
		const args = {
			category: "quick",
			prompt: "test prompt",
			description: "Test task",
			run_in_background: false,
			load_skills: [],
			blockedBy: undefined,
			enableSkillTools: false,
		}
		const executorCtx = createMockExecutorContext()
		executorCtx.userCategories = {
			quick: {
				model: "openai/gpt-5.4 high",
			},
		}

		//#when
		const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

		//#then
		expect(result.error).toBeUndefined()
		expect(result.actualModel).toBeDefined()
		expect(result.categoryModel).toBeDefined()
		if (!result.actualModel || !result.categoryModel) {
			throw new Error("Expected resolved model and category model")
		}
		expect(result.actualModel).toBe("openai/gpt-5.4")
		expect(result.categoryModel).toEqual({
			providerID: "openai",
			modelID: "gpt-5.4",
			variant: "high",
		})
	})

	test("does not apply object-style fallback settings when the configured primary model matches directly", async () => {
		//#given
		const cacheSpy = spyOn(connectedProvidersCache, "readProviderModelsCache").mockReturnValue({
			models: { openai: ["gpt-5.4-preview"] },
			connected: ["openai"],
			updatedAt: "2026-03-03T00:00:00.000Z",
		})
		const agentsSpy = spyOn(connectedProvidersCache, "readConnectedProvidersCache").mockReturnValue(["openai"])
		const args = {
			category: "quick",
			prompt: "test prompt",
			description: "Test task",
			run_in_background: false,
			load_skills: [],
			blockedBy: undefined,
			enableSkillTools: false,
		}
		const executorCtx = createMockExecutorContext()
		executorCtx.userCategories = {
			quick: {
				model: "openai/gpt-5.4-preview",
				fallback_models: [
					{
						model: "openai/gpt-5.4",
						variant: "low",
						reasoningEffort: "high",
					},
				],
			},
		}

		//#when
		const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

		//#then
		expect(result.error).toBeUndefined()
		expect(result.actualModel).toBe("openai/gpt-5.4-preview")
		expect(result.categoryModel).toEqual({
			providerID: "openai",
			modelID: "gpt-5.4-preview",
			variant: undefined,
		})
		cacheSpy.mockRestore()
		agentsSpy.mockRestore()
	})

	test("matches promoted fallback settings after fuzzy model resolution", async () => {
		//#given
		const cacheSpy = spyOn(connectedProvidersCache, "readProviderModelsCache").mockReturnValue({
			models: { openai: ["gpt-5.4-preview"] },
			connected: ["openai"],
			updatedAt: "2026-03-03T00:00:00.000Z",
		})
		const agentsSpy = spyOn(connectedProvidersCache, "readConnectedProvidersCache").mockReturnValue(["openai"])
		const args = {
			category: "quick",
			prompt: "test prompt",
			description: "Test task",
			run_in_background: false,
			load_skills: [],
			blockedBy: undefined,
			enableSkillTools: false,
		}
		const executorCtx = createMockExecutorContext()
		executorCtx.userCategories = {
			quick: {
				fallback_models: [
					{
						model: "openai/gpt-5.4",
						variant: "low",
						reasoningEffort: "high",
						temperature: 0.6,
						top_p: 0.5,
						maxTokens: 1234,
						thinking: { type: "disabled" },
					},
				],
			},
		}

		//#when
		const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

		//#then
		expect(result.error).toBeUndefined()
		expect(result.actualModel).toBe("openai/gpt-5.4-preview")
		expect(result.categoryModel).toEqual({
			providerID: "openai",
			modelID: "gpt-5.4-preview",
			variant: "low",
			reasoningEffort: "high",
			temperature: 0.6,
			top_p: 0.5,
			maxTokens: 1234,
			thinking: { type: "disabled" },
		})
		cacheSpy.mockRestore()
		agentsSpy.mockRestore()
	})

	test("prefers exact promoted fallback match over earlier fuzzy prefix match", async () => {
		//#given
		const cacheSpy = spyOn(connectedProvidersCache, "readProviderModelsCache").mockReturnValue({
			models: { openai: ["gpt-5.4-preview"] },
			connected: ["openai"],
			updatedAt: "2026-03-03T00:00:00.000Z",
		})
		const agentsSpy = spyOn(connectedProvidersCache, "readConnectedProvidersCache").mockReturnValue(["openai"])
		const args = {
			category: "quick",
			prompt: "test prompt",
			description: "Test task",
			run_in_background: false,
			load_skills: [],
			blockedBy: undefined,
			enableSkillTools: false,
		}
		const executorCtx = createMockExecutorContext()
		executorCtx.userCategories = {
			quick: {
				fallback_models: [
					{
						model: "openai/gpt-5.4",
						variant: "low",
						reasoningEffort: "medium",
					},
					{
						model: "openai/gpt-5.4-preview",
						variant: "max",
						reasoningEffort: "high",
					},
				],
			},
		}

		//#when
		const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

		//#then
		expect(result.error).toBeUndefined()
		expect(result.actualModel).toBe("openai/gpt-5.4-preview")
		expect(result.categoryModel).toEqual({
			providerID: "openai",
			modelID: "gpt-5.4-preview",
			variant: "max",
			reasoningEffort: "high",
		})
		cacheSpy.mockRestore()
		agentsSpy.mockRestore()
	})

	test("matches promoted fallback settings when fuzzy resolution extends configured model without hyphen", async () => {
		//#given
		const cacheSpy = spyOn(connectedProvidersCache, "readProviderModelsCache").mockReturnValue({
			models: { openai: ["gpt-5.4o"] },
			connected: ["openai"],
			updatedAt: "2026-03-03T00:00:00.000Z",
		})
		const agentsSpy = spyOn(connectedProvidersCache, "readConnectedProvidersCache").mockReturnValue(["openai"])
		const args = {
			category: "quick",
			prompt: "test prompt",
			description: "Test task",
			run_in_background: false,
			load_skills: [],
			blockedBy: undefined,
			enableSkillTools: false,
		}
		const executorCtx = createMockExecutorContext()
		executorCtx.userCategories = {
			quick: {
				fallback_models: [
					{
						model: "openai/gpt-5.4",
						variant: "low",
						reasoningEffort: "high",
					},
				],
			},
		}

		//#when
		const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

		//#then
		expect(result.error).toBeUndefined()
		expect(result.actualModel).toBe("openai/gpt-5.4o")
		expect(result.categoryModel).toEqual({
			providerID: "openai",
			modelID: "gpt-5.4o",
			variant: "low",
			reasoningEffort: "high",
		})
		cacheSpy.mockRestore()
		agentsSpy.mockRestore()
	})

	test("prefers the most specific prefix match when fallback entries share a prefix", async () => {
		//#given
		const cacheSpy = spyOn(connectedProvidersCache, "readProviderModelsCache").mockReturnValue({
			models: { openai: ["gpt-4o"] },
			connected: ["openai"],
			updatedAt: "2026-03-03T00:00:00.000Z",
		})
		const agentsSpy = spyOn(connectedProvidersCache, "readConnectedProvidersCache").mockReturnValue(["openai"])
		const args = {
			category: "deep",
			prompt: "test prompt",
			description: "Test task",
			run_in_background: false,
			load_skills: [],
			blockedBy: undefined,
			enableSkillTools: false,
		}
		const executorCtx = createMockExecutorContext()
		executorCtx.userCategories = {
			deep: {
				fallback_models: [
					{
						model: "openai/gpt-4",
						variant: "low",
						reasoningEffort: "medium",
					},
					{
						model: "openai/gpt-4o",
						variant: "max",
						reasoningEffort: "high",
					},
				],
			},
		}

		//#when
		const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

		//#then
		expect(result.error).toBeUndefined()
		expect(result.actualModel).toBe("openai/gpt-4o")
		expect(result.categoryModel).toEqual({
			providerID: "openai",
			modelID: "gpt-4o",
			variant: "max",
			reasoningEffort: "high",
		})
		cacheSpy.mockRestore()
		agentsSpy.mockRestore()
	})

	test("does not inherit hardcoded fallbackChain when user configures a category model [regression #3040]", async () => {
		//#given
		const args = {
			category: "quick",
			prompt: "test prompt",
			description: "Test task",
			run_in_background: false,
			load_skills: [],
			blockedBy: undefined,
			enableSkillTools: false,
		}
		const executorCtx = createMockExecutorContext()
		executorCtx.userCategories = {
			quick: {
				model: "animal-gateway-xai/grok-4-fast-non-reasoning",
			},
		}

		//#when
		const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

		//#then
		expect(result.error).toBeUndefined()
		expect(result.actualModel).toBe("animal-gateway-xai/grok-4-fast-non-reasoning")
		expect(result.categoryModel).toEqual({
			providerID: "animal-gateway-xai",
			modelID: "grok-4-fast-non-reasoning",
			variant: undefined,
		})
		expect(result.fallbackChain).toBeUndefined()
	})

	test("does not inherit hardcoded fallbackChain when sisyphus-junior model override is set [regression #2941]", async () => {
		//#given
		const args = {
			category: "quick",
			prompt: "test prompt",
			description: "Test task",
			run_in_background: false,
			load_skills: [],
			blockedBy: undefined,
			enableSkillTools: false,
		}
		const executorCtx = createMockExecutorContext()
		executorCtx.sisyphusJuniorModel = "anthropic/claude-sonnet-4-6"

		//#when
		const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

		//#then
		expect(result.error).toBeUndefined()
		expect(result.actualModel).toBe("anthropic/claude-sonnet-4-6")
		expect(result.categoryModel).toEqual({
			providerID: "anthropic",
			modelID: "claude-sonnet-4-6",
			variant: undefined,
		})
		expect(result.fallbackChain).toBeUndefined()
	})

	test("uses sisyphus-junior fallback_models when its model override drives category routing", async () => {
		//#given
		const args = {
			category: "quick",
			prompt: "test prompt",
			description: "Test task",
			run_in_background: false,
			load_skills: [],
			blockedBy: undefined,
			enableSkillTools: false,
		}
		const executorCtx = createMockExecutorContext()
		executorCtx.sisyphusJuniorModel = "anthropic/claude-sonnet-4-6"
		executorCtx.agentOverrides = {
			"sisyphus-junior": {
				model: "anthropic/claude-sonnet-4-6",
				fallback_models: ["openai/gpt-5.5(high)"],
			},
		}

		//#when
		const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

		//#then
		expect(result.error).toBeUndefined()
		expect(result.actualModel).toBe("anthropic/claude-sonnet-4-6")
		expect(result.categoryModel).toEqual({
			providerID: "anthropic",
			modelID: "claude-sonnet-4-6",
			variant: undefined,
		})
		expect(result.fallbackChain?.[0]).toEqual({
			providers: ["openai"],
			model: "gpt-5.5",
			variant: "high",
		})
	})

	test("uses GPT-5.5 deep prompt append when category model resolves to gpt-5.5", async () => {
		//#given
		const args = {
			category: "deep",
			prompt: "test prompt",
			description: "Test task",
			run_in_background: false,
			load_skills: [],
			blockedBy: undefined,
			enableSkillTools: false,
		}
		const executorCtx = createMockExecutorContext()
		executorCtx.userCategories = {
			deep: { model: "openai/gpt-5.5", variant: "medium" },
		}

		//#when
		const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

		//#then
		expect(result.error).toBeUndefined()
		expect(result.actualModel).toBe("openai/gpt-5.5")
		expect(result.categoryPromptAppend).toBeDefined()
		expect(result.categoryPromptAppend).toContain("operating in DEEP mode")
		expect(result.categoryPromptAppend).toContain("five to fifteen minutes")
		expect(result.categoryPromptAppend).toContain("Routine Verification Routing")
		expect(result.categoryPromptAppend).toContain('category="quick"')
		expect(result.categoryPromptAppend).toContain("must not make autonomous fixes")
		expect(result.categoryPromptAppend).toContain("Never route UI/design, architecture, hard debugging")
	})

	test("uses legacy deep prompt append when category model resolves to gpt-5.4", async () => {
		//#given
		const args = {
			category: "deep",
			prompt: "test prompt",
			description: "Test task",
			run_in_background: false,
			load_skills: [],
			blockedBy: undefined,
			enableSkillTools: false,
		}
		const executorCtx = createMockExecutorContext()
		executorCtx.userCategories = {
			deep: { model: "openai/gpt-5.4" },
		}

		//#when
		const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

		//#then
		expect(result.error).toBeUndefined()
		expect(result.actualModel).toBe("openai/gpt-5.4")
		expect(result.categoryPromptAppend).toBeDefined()
		expect(result.categoryPromptAppend).toContain("GOAL-ORIENTED AUTONOMOUS")
		expect(result.categoryPromptAppend).not.toContain("operating in DEEP mode")
	})

	test("appends user prompt_append to GPT-5.5 deep base prompt", async () => {
		//#given
		const args = {
			category: "deep",
			prompt: "test prompt",
			description: "Test task",
			run_in_background: false,
			load_skills: [],
			blockedBy: undefined,
			enableSkillTools: false,
		}
		const executorCtx = createMockExecutorContext()
		executorCtx.userCategories = {
			deep: {
				model: "openai/gpt-5.5",
				prompt_append: "USER_CUSTOM_INSTRUCTION_XYZ",
			},
		}

		//#when
		const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

		//#then
		expect(result.error).toBeUndefined()
		expect(result.categoryPromptAppend).toContain("operating in DEEP mode")
		expect(result.categoryPromptAppend).toContain("USER_CUSTOM_INSTRUCTION_XYZ")
	})

	test("appends user prompt_append to legacy deep base prompt for non-gpt-5.5 models", async () => {
		//#given
		const args = {
			category: "deep",
			prompt: "test prompt",
			description: "Test task",
			run_in_background: false,
			load_skills: [],
			blockedBy: undefined,
			enableSkillTools: false,
		}
		const executorCtx = createMockExecutorContext()
		executorCtx.userCategories = {
			deep: {
				model: "openai/gpt-5.4",
				prompt_append: "USER_CUSTOM_INSTRUCTION_LEGACY",
			},
		}

		//#when
		const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

		//#then
		expect(result.error).toBeUndefined()
		expect(result.categoryPromptAppend).toContain("GOAL-ORIENTED AUTONOMOUS")
		expect(result.categoryPromptAppend).toContain("USER_CUSTOM_INSTRUCTION_LEGACY")
	})

	test("appends routine verification policy to custom category prompt append", async () => {
		//#given
		const args = {
			category: "repo-check",
			prompt: "test prompt",
			description: "Test task",
			run_in_background: false,
			load_skills: [],
			blockedBy: undefined,
			enableSkillTools: false,
		}
		const executorCtx = createMockExecutorContext()
		executorCtx.userCategories = {
			"repo-check": {
				model: "openai/gpt-5.4",
				prompt_append: "CUSTOM_CATEGORY_INSTRUCTION_XYZ",
			},
		}

		//#when
		const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

		//#then
		expect(result.error).toBeUndefined()
		expect(result.actualModel).toBe("openai/gpt-5.4")
		expect(result.categoryPromptAppend).toBeDefined()
		const promptAppend = result.categoryPromptAppend ?? ""
		expect(promptAppend).toContain("CUSTOM_CATEGORY_INSTRUCTION_XYZ")
		expect(promptAppend).toContain("Routine Verification Routing")
		expect(promptAppend).toContain('category="quick"')
		expect(promptAppend).toContain("If quick verification fails")
		expect(promptAppend.indexOf("CUSTOM_CATEGORY_INSTRUCTION_XYZ")).toBeLessThan(
			promptAppend.indexOf("Routine Verification Routing"),
		)
	})

	test("applyCategoryParams propagates category tools config (issue #5182)", () => {
		//#given a category with tools restriction
		const base: DelegatedModelConfig = {
			providerID: "anthropic",
			modelID: "claude-sonnet-4-6",
		}
		const config: CategoryConfig = {
			tools: { grep: false, read: true },
		}

		//#when applyCategoryParams runs with a tools-restricted category config
		const result = applyCategoryParams(base, config)

		//#then tools from the category config should appear in the result
		// THIS TEST MUST FAIL (RED) - proves bug #5182 that applyCategoryParams drops config.tools
		expect((result as unknown as { tools?: Record<string, boolean> }).tools).toEqual({ grep: false, read: true })
	})
})
