import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import type { ExecutorContext } from "../executor-types"
import type { DelegateTaskArgs } from "../types"
import { buildTaskPromptBody } from "../../../features/background-agent/spawner/task-prompt-body"
import { applySessionPromptParams } from "../../../shared/session-prompt-params-helpers"

type SubagentResolverModule = typeof import("../subagent-resolver")

const logMock = mock((..._args: unknown[]) => {})
const readConnectedProvidersCacheMock = mock(() => null as string[] | null)
const readProviderModelsCacheMock = mock(
  () => null as {
    models: Record<string, string[]>
    connected: string[]
    updatedAt: string
  } | null,
)

async function importFreshSubagentResolverModule(): Promise<SubagentResolverModule> {
  return await import(`../subagent-resolver?test=${Date.now()}-${Math.random()}`)
}

function createBaseArgs(overrides?: Partial<DelegateTaskArgs>): DelegateTaskArgs {
  return {
    description: "Run review",
    prompt: "Review the current changes",
    run_in_background: false,
    load_skills: [],
    subagent_type: "oracle",
    ...overrides,
  }
}

function createExecutorContext(
  agentsFn: () => Promise<unknown>,
  overrides?: Partial<ExecutorContext>,
): ExecutorContext {
  const client = {
    app: {
      agents: agentsFn,
    },
  } as ExecutorContext["client"]

  return {
    client,
    manager: {} as ExecutorContext["manager"],
    directory: "/tmp/test",
    ...overrides,
  }
}

describe("resolveSubagentExecution agent overrides", () => {
  let resolveSubagentExecution: SubagentResolverModule["resolveSubagentExecution"]

  beforeEach(async () => {
    mock.restore()
    logMock.mockClear()
    readConnectedProvidersCacheMock.mockReset()
    readProviderModelsCacheMock.mockReset()
    readConnectedProvidersCacheMock.mockReturnValue(null)
    readProviderModelsCacheMock.mockReturnValue(null)
    mock.module("../../../shared/logger", () => ({
      log: logMock,
    }))
    mock.module("../../../shared/connected-providers-cache", () => ({
      readConnectedProvidersCache: readConnectedProvidersCacheMock,
      readProviderModelsCache: readProviderModelsCacheMock,
      hasConnectedProvidersCache: () => readConnectedProvidersCacheMock() !== null,
      hasProviderModelsCache: () => readProviderModelsCacheMock() !== null,
      _resetMemCacheForTesting: () => {},
    }))
    ;({ resolveSubagentExecution } = await importFreshSubagentResolverModule())
  })

  afterEach(() => {
    mock.restore()
  })

  test.each([
    { name: "chain-entry reasoning", override: { models: [{ model: "openai/gpt-6.1-sol", reasoning: "medium" }] }, reasoning: "medium", variant: "medium" },
    { name: "selected fallback reasoning", override: { models: [{ model: "unavailable/missing", reasoning: "high" }, { model: "openai/gpt-6.1-sol", reasoning: "medium" }] }, reasoning: "medium", variant: "medium" },
    { name: "agent-level reasoning over category", override: { model: "openai/gpt-6.1-sol", reasoning: "medium", category: "worker" }, reasoning: "medium", variant: "medium" },
    { name: "agent variant over category", override: { model: "openai/gpt-6.1-sol", variant: "medium", category: "worker" }, reasoning: "medium", variant: "medium" },
    { name: "markdown variant over category", override: { category: "worker" }, markdownVariant: "medium", reasoning: "medium", variant: "medium" },
    { name: "explicit call reasoning over chain", override: { models: [{ model: "openai/gpt-6.1-sol", reasoning: "high" }] }, callReasoning: "medium", reasoning: "medium", variant: "medium" },
    { name: "unknown call reasoning as provider variant", override: { model: "openai/gpt-6.1-sol", reasoning: "high" }, callReasoning: "provider-custom", reasoning: "provider-custom", variant: "provider-custom" },
    { name: "non-variant reasoning effort", override: { model: "openai/gpt-6.1-sol", reasoning: "off" }, reasoning: "off", variant: undefined, effort: "none" },
    { name: "no reasoning unchanged", override: { model: "openai/gpt-6.1-sol" }, reasoning: undefined, variant: undefined },
  ] satisfies Array<{
    name: string
    override: NonNullable<ExecutorContext["agentOverrides"]>[string]
    markdownVariant?: string
    callReasoning?: string
    reasoning: string | undefined
    variant: string | undefined
    effort?: "none"
  }>)("propagates $name to the delegated prompt", async (scenario) => {
    // given: differing agent and category settings, and only the selected model available
    readProviderModelsCacheMock.mockReturnValue({
      models: { openai: ["gpt-6.1-sol"] }, connected: ["openai"], updatedAt: "2026-10-02",
    })
    readConnectedProvidersCacheMock.mockReturnValue(["openai"])
    const executorCtx = createExecutorContext(async () => ({ data: [{
      name: "configured-worker", mode: "subagent", model: "openai/gpt-6.1-sol",
      variant: "markdownVariant" in scenario ? scenario.markdownVariant : undefined,
    }] }), {
      agentOverrides: { "configured-worker": scenario.override },
      userCategories: { worker: { reasoning: "high", variant: "high" } },
    })
    const args = createBaseArgs({ subagent_type: "configured-worker",
      reasoning: "callReasoning" in scenario ? scenario.callReasoning : undefined })

    // when: direct-agent resolution feeds the real background prompt lowering path
    const result = await resolveSubagentExecution(args, executorCtx, "sisyphus", "deep")
    const body = buildTaskPromptBody({ kind: "launch", agent: result.agentToUse,
      model: result.categoryModel, system: undefined, prompt: args.prompt, includeTeamToolDenylist: false })

    // then: the selected effort, not the category/primary effort, reaches the prompt
    expect(result.error).toBeUndefined()
    expect(result.categoryModel).toMatchObject({ providerID: "openai", modelID: "gpt-6.1-sol" })
    expect(result.categoryModel?.reasoning).toBe(scenario.reasoning)
    expect(body.variant).toBe(scenario.variant)
    if ("effort" in scenario) {
      expect(applySessionPromptParams("ses_reasoning_test", result.categoryModel)).toEqual({ reasoningEffort: scenario.effort })
    }
  })

  test.each([
    { name: "normalized fallback spelling", fallback: "anthropic/claude-sonnet-4.5" },
    { name: "earlier rung instead of longest prefix", fallback: "anthropic/claude-sonnet-4" },
  ])("keeps selected reasoning for $name", async ({ fallback }) => {
    // given: the selected rung differs from both defaults and a later exact-model rung
    readProviderModelsCacheMock.mockReturnValue({
      models: { anthropic: ["claude-sonnet-4-5"] }, connected: ["anthropic"], updatedAt: "2026-10-02",
    })
    readConnectedProvidersCacheMock.mockReturnValue(["anthropic"])
    const ctx = createExecutorContext(async () => ({ data: [{
      name: "configured-worker", mode: "subagent", model: "unavailable/missing",
    }] }), {
      agentOverrides: { "configured-worker": { reasoning: "high", category: "worker", models: [
        "unavailable/missing", { model: fallback, reasoning: "medium" },
        { model: "anthropic/claude-sonnet-4-5", reasoning: "xhigh" },
      ] } },
      userCategories: { worker: { reasoning: "low" } },
    })
    // when: the first reachable fallback is selected with normalized substring matching
    const result = await resolveSubagentExecution(createBaseArgs({ subagent_type: "configured-worker" }), ctx, "sisyphus", "deep")
    // then: provenance retains that rung's settings, not defaults or a re-matched rung
    expect(result.error).toBeUndefined()
    expect(result.categoryModel).toMatchObject({ providerID: "anthropic", modelID: "claude-sonnet-4-5", reasoning: "medium" })
  })

  test("does not inherit hardcoded fallback chain when agent override uses custom provider model", async () => {
    // given
    readProviderModelsCacheMock.mockReturnValue({
      models: { openai: ["gemini-3.5-flash-thinking"] },
      connected: ["openai"],
      updatedAt: "2026-03-03T00:00:00.000Z",
    })
    readConnectedProvidersCacheMock.mockReturnValue(["openai"])
    const args = createBaseArgs({ subagent_type: "oracle" })
    const executorCtx = createExecutorContext(
      async () => ([
        { name: "oracle", mode: "subagent", model: "anthropic/claude-opus-4-7" },
      ]),
      {
        agentOverrides: {
          oracle: {
            model: "openai/gemini-3.5-flash-thinking",
          },
        } as ExecutorContext["agentOverrides"],
      },
    )

    // when
    const result = await resolveSubagentExecution(args, executorCtx, "sisyphus", "deep")

    // then
    expect(result.error).toBeUndefined()
    expect(result.categoryModel).toEqual({
      providerID: "openai",
      modelID: "gemini-3.5-flash-thinking",
    })
    expect(result.fallbackChain).toBeUndefined()
  })
})
