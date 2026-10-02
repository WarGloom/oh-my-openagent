import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OhMyOpenCodeConfigSchema } from "../../config/schema"
import { JevRoutingConfigSchema } from "../../config/schema/jev-routing"
import { loadOmoOpenCodeConfigChain } from "../../plugin-config/omo-config-chain"
import * as providerCache from "../../shared/connected-providers-cache"
import { resolveMember } from "../../features/team-mode/team-runtime/resolve-member"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { resolveCategoryExecution } from "./category-resolver"
import { CATEGORY_DESCRIPTIONS } from "./constants"
import type { ExecutorContext } from "./executor-types"
import { selectAgentWithJev, selectCategoryTierWithJev, type JevRoutingInput } from "./jev-routing"
import { createDelegateTask } from "./tools"

const config = JevRoutingConfigSchema.parse({
  mode: "active", ladder: ["cheap", "strong"], default: "strong",
})
const categories = {
  auto: { description: "Route a delegation to a tier" },
  cheap: { description: "Small bounded tasks", models: ["example/low", "other/backup"] },
  strong: { description: "Complex decisions", models: ["example/high", "other/reserve"] },
}

function input(overrides: Partial<JevRoutingInput> = {}): JevRoutingInput {
  return {
    brief: "Implement the bounded change",
    config,
    categories,
    enabledCategories: categories,
    ...overrides,
  }
}

function reply(scores: readonly number[], overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    model: "jev-1.13.0",
    answers: Object.fromEntries(scores.map((score, index) => [`tier_${index}`, { type: "noul", noul: score }])),
    ...overrides,
  })
}

describe("Jev auto tier routing", () => {
  let fetchSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(reply([0.7, 0.9]))
  })
  afterEach(() => fetchSpy.mockRestore())

  test("chooses the cheapest qualifying tier without sending model IDs or credentials", async () => {
    // given: two ordered tiers with descriptions and private model chains
    // when: both qualify
    expect(await selectCategoryTierWithJev(input())).toBe("cheap")
    // then: the wire contract contains only tier names, descriptions and the brief
    const [url, init] = fetchSpy.mock.calls[0] ?? []
    expect(url).toBe("https://opencode.ai/zen/v1/systemone")
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { "content-type": "application/json" } })
    const body = JSON.parse(init.body)
    expect(body.model).toBe("jev-1.13-free")
    expect(body.state).toBe(input().brief)
    expect(Object.keys(body.questions)).toEqual(["tier_0", "tier_1"])
    expect(body.questions.tier_0.instructions).toContain("cheap")
    expect(body.questions.tier_0.instructions).toContain("Small bounded tasks")
    expect(body.questions.tier_1.instructions).toContain("Complex decisions")
    expect(init.body).not.toContain("example/low")
    expect(init.body).not.toContain("other/backup")
  })

  test("uses builtin tier descriptions unless a category config overrides them", async () => {
    // given: a builtin tier without a configured description
    const tierConfig = { ...config, ladder: ["quick", "strong"] }
    const base = input({
      config: tierConfig,
      categories: { auto: categories.auto, quick: {}, strong: {} },
      enabledCategories: { quick: {}, strong: {} },
    })
    // when: Jev scores the builtin and then an explicitly described tier
    await selectCategoryTierWithJev(base)
    await selectCategoryTierWithJev(input({
      ...base,
      categories: { ...base.categories, quick: { description: "Custom quick tier" } },
      enabledCategories: { quick: { description: "Custom quick tier" }, strong: {} },
    }))
    // then: builtin prose is reused, while the user override wins
    const builtinQuestion = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body).questions.tier_0
    const overriddenQuestion = JSON.parse(fetchSpy.mock.calls[1]?.[1]?.body).questions.tier_0
    expect(CATEGORY_DESCRIPTIONS.quick).toBeTruthy()
    expect(builtinQuestion.instructions).toContain(CATEGORY_DESCRIPTIONS.quick)
    expect(builtinQuestion.criteria.true).toContain(CATEGORY_DESCRIPTIONS.quick)
    expect(overriddenQuestion.instructions).toContain("Custom quick tier")
    expect(overriddenQuestion.criteria.true).toContain("Custom quick tier")
    expect(overriddenQuestion.instructions).not.toContain(CATEGORY_DESCRIPTIONS.quick)
  })

  test("falls back when unsure, and observes without changing the tier", async () => {
    // given: no suitable tier or an observe-only configuration
    fetchSpy.mockResolvedValueOnce(reply([0.4, 0.5])).mockResolvedValueOnce(reply([0.9, 0.9]))
    // when: both decisions complete
    expect(await selectCategoryTierWithJev(input())).toBe("strong")
    expect(await selectCategoryTierWithJev(input({ config: { ...config, mode: "observe" } }))).toBe("strong")
    // then: observe sent exactly one additional request
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test("off, opt-out and oversized briefs use default without requests", async () => {
    // given: bypass conditions
    expect(await selectCategoryTierWithJev(input({ config: { ...config, mode: "off" } }))).toBe("strong")
    expect(await selectCategoryTierWithJev(input({ modelRouting: false }))).toBe("strong")
    expect(await selectCategoryTierWithJev(input({ brief: "x".repeat(8193) }))).toBe("strong")
    // then: no remote call occurs
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test.each([
    ["HTTP", new Response("private body", { status: 503 })],
    ["missing answer", reply([0.95])],
    ["out-of-range score", reply([0.5, 1.2])],
    ["extra answer", reply([0.5, 0.9, 0.9])],
    ["wrong answer type", reply([], { answers: { tier_0: { type: "confidence", confidence: 1 }, tier_1: { type: "noul", noul: 1 } } })],
  ])("falls back on %s response", async (_reason, response) => {
    // given: an invalid remote response
    fetchSpy.mockResolvedValue(response)
    // when: Jev responds
    expect(await selectCategoryTierWithJev(input())).toBe("strong")
  })

  test("rejects oversized valid replies with absent, false-small or oversized content-length", async () => {
    // given: a valid response that would select cheap if parsed
    const payload = JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        tier_0: { type: "noul", noul: 0.95 },
        tier_1: { type: "noul", noul: 0.1 },
      },
      padding: "x".repeat(65536),
    })
    const bytes = new TextEncoder().encode(payload)
    expect(bytes.byteLength).toBeGreaterThan(65536)
    for (const contentLength of [undefined, "2", String(bytes.byteLength)]) {
      const cancel = mock(() => undefined)
      const response = new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(bytes) },
        cancel,
      }), contentLength === undefined ? undefined : { headers: { "content-length": contentLength } })
      fetchSpy.mockResolvedValueOnce(response)
      // when: each oversized reply is received
      expect(await selectCategoryTierWithJev(input())).toBe("strong")
      // then: streaming or header rejection cancels the unread remainder
      expect(cancel).toHaveBeenCalledTimes(1)
    }
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  test("finite oversized valid reply falls back instead of selecting cheap", async () => {
    // given: a complete, closed JSON reply whose scores would select cheap
    const response = reply([0.95, 0.1], { padding: "x".repeat(65536) })
    expect(response.headers.get("content-length")).toBeNull()
    fetchSpy.mockResolvedValue(response)
    // when: Jev returns an oversized but otherwise valid reply
    const selected = await selectCategoryTierWithJev(input())
    // then: the response cap forces the default tier
    expect(selected).toBe("strong")
  })

  test("falls back on timeout but propagates tool cancellation", async () => {
    // given: a pending request
    fetchSpy.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
    }))
    // when: the timeout fires
    expect(await selectCategoryTierWithJev(input({ config: { ...config, timeout_ms: 100 } }))).toBe("strong")
    const controller = new AbortController()
    const pending = selectCategoryTierWithJev(input({ signal: controller.signal }))
    controller.abort()
    // then: cancellation cannot dispatch a worker
    expect((await Promise.allSettled([pending]))[0]).toMatchObject({ status: "rejected", reason: { name: "AbortError" } })
  })

  test("invalid auto or ladder disables routing and uses a valid default", async () => {
    // given: forbidden auto model settings, missing or disabled tier, duplicate tier
    for (const override of [
      { categories: { ...categories, auto: { description: "Route", models: ["example/low"] } } },
      { enabledCategories: { ...categories, cheap: undefined } },
      { config: { ...config, ladder: ["cheap", "cheap"] } },
      { config: { ...config, ladder: ["__proto__", "strong"] } },
      { config: { ...config, ladder: ["constructor", "strong"] } },
    ]) {
      // when: the configuration is examined
      expect(await selectCategoryTierWithJev(input(override as Partial<JevRoutingInput>))).toBe("strong")
    }
    // then: invalid default cannot dispatch
    expect(await selectCategoryTierWithJev(input({ config: { ...config, default: "missing" } }))).toBeUndefined()
    expect(await selectCategoryTierWithJev(input({ config: { ...config, default: "__proto__" } }))).toBeUndefined()
    expect(await selectCategoryTierWithJev(input({ config: { ...config, default: "constructor" } }))).toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

test("Jev schema validates bounds and rejects the former per-model configuration", () => {
  expect(JevRoutingConfigSchema.parse({ ladder: ["quick", "deep"], default: "quick" })).toMatchObject({
    mode: "off", timeout_ms: 2000, min_suitability: 0.6,
  })
  for (const invalid of [
    { ladder: ["quick"], default: "quick" },
    { ladder: Array(9).fill("quick"), default: "quick" },
    { ladder: ["quick", "deep"], default: "quick", timeout_ms: 99 },
    { ladder: ["quick", "deep"], default: "quick", min_suitability: 1.1 },
    { ladder: ["quick", "deep"], default: "quick", categories: {} },
  ]) expect(JevRoutingConfigSchema.safeParse(invalid).success).toBe(false)
})

test("global [opencode] tier settings survive the unified loader", () => {
  const home = mkdtempSync(join(tmpdir(), "omo-jev-config-"))
  try {
    mkdirSync(join(home, ".omo"))
    writeFileSync(join(home, ".omo", "omo.jsonc"), JSON.stringify({ "[opencode]": { jev_routing: config, categories } }))
    const chain = loadOmoOpenCodeConfigChain(home, { HOME: home })
    const parsed = OhMyOpenCodeConfigSchema.parse(Object.assign({}, ...chain.views.map((view) => view.config)))
    expect(parsed.jev_routing?.ladder).toEqual(["cheap", "strong"])
    expect(parsed.categories?.auto).toEqual({ description: "Route a delegation to a tier" })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("auto resolves the selected tier's unchanged full cross-provider fallback chain", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(reply([0.8, 0.9]))
  const cacheSpy = spyOn(providerCache, "readProviderModelsCache").mockReturnValue({
    connected: ["example", "other"], models: { example: ["low", "high"], other: ["backup", "reserve"] }, updatedAt: "2026-09-28",
  })
  try {
    const ctx: ExecutorContext = {
      client: { model: { list: async () => ({ data: [] }) } } as ExecutorContext["client"],
      manager: {} as ExecutorContext["manager"], directory: "/tmp", userCategories: categories, jevRouting: config,
    }
    const args = { category: "auto", prompt: "Implement feature", description: "Feature", run_in_background: false, load_skills: [] }
    const result = await resolveCategoryExecution(args, ctx, undefined, undefined)
    expect(args.category).toBe("cheap")
    expect(result.error).toBeUndefined()
    expect(result.actualModel).toBe("example/low")
    expect(result.fallbackChain?.map((entry) => [entry.providers, entry.model])).toEqual([[ ["other"], "backup" ]])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const bypass = { ...args, category: "auto", model_routing: false as const }
    expect((await resolveCategoryExecution(bypass, ctx, undefined, undefined)).actualModel).toBe("example/high")
    expect(bypass.category).toBe("strong")
    expect((await resolveCategoryExecution({ ...args, category: "strong" }, ctx, undefined, undefined)).actualModel).toBe("example/high")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  } finally {
    cacheSpy.mockRestore()
    fetchSpy.mockRestore()
  }
})

test("category team members use the shared auto resolver and retain the effective category", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(reply([0.8, 0.9]))
  const cacheSpy = spyOn(providerCache, "readProviderModelsCache").mockReturnValue({
    connected: ["example", "other"], models: { example: ["low", "high"], other: ["backup", "reserve"] }, updatedAt: "2026-09-28",
  })
  try {
    const ctx: ExecutorContext = {
      client: { model: { list: async () => ({ data: [] }) } } as ExecutorContext["client"],
      manager: {} as ExecutorContext["manager"], directory: "/tmp", userCategories: categories, jevRouting: config,
    }
    const member = await resolveMember(unsafeTestValue({ kind: "category", name: "worker", category: "auto", prompt: "Implement feature" }), ctx, "")
    expect(member.category).toBe("cheap")
    expect(member.model).toMatchObject({ providerID: "example", modelID: "low" })
    expect(member.fallbackChain?.map((entry) => entry.model)).toEqual(["backup"])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  } finally {
    cacheSpy.mockRestore()
    fetchSpy.mockRestore()
  }
})

test("task_id continuation with auto bypasses Jev", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(reply([0.9, 0.9]))
  const promptAsync = mock(async () => ({ data: {} }))
  const priorUser = { info: { id: "msg_1", role: "user" }, parts: [{ type: "text", text: "Earlier request" }] }
  const prior = { info: { id: "msg_2", role: "assistant", agent: "Sisyphus-Junior", model: { providerID: "example", modelID: "low" }, finish: "stop" }, parts: [{ type: "text", text: "Earlier answer" }] }
  const continuationUser = { info: { id: "msg_3", role: "user" }, parts: [{ type: "text", text: "Continue" }] }
  const continued = { info: { id: "msg_4", role: "assistant", agent: "Sisyphus-Junior", model: { providerID: "example", modelID: "low" }, finish: "stop" }, parts: [{ type: "text", text: "Continued answer" }] }
  const client = {
    app: { agents: async () => ({ data: [] }) },
    config: { get: async () => ({ data: {} }) },
    session: {
      get: async () => ({ data: { id: "ses_earlier", parentID: "ses_parent", directory: "/tmp" } }),
      messages: async () => ({ data: promptAsync.mock.calls.length ? [priorUser, prior, continuationUser, continued] : [priorUser, prior] }),
      status: async () => ({ data: { ses_earlier: { type: "idle" } } }),
      promptAsync,
      abort: async () => ({ data: {} }),
    },
  }
  const delegate = createDelegateTask(unsafeTestValue({ manager: {}, client, directory: "/tmp", userCategories: categories,
    jevRouting: { ...config, agent_ladders: { "worker-choice": { ladder: ["cheap-agent", "strong-agent"], default: "strong-agent" } } } }))
  try {
    const result = await delegate.execute({ task_id: "ses_earlier", category: "auto", prompt: "Continue", description: "Resume", load_skills: [] },
      unsafeTestValue({ sessionID: "ses_parent", messageID: "msg_parent", agent: "sisyphus", abort: new AbortController().signal }))
    expect(result).toContain("Continued answer")
    expect(promptAsync).toHaveBeenCalledWith(expect.objectContaining({ path: { id: "ses_earlier" } }))
    expect(fetchSpy).not.toHaveBeenCalled()
    await delegate.execute({ task_id: "ses_earlier", subagent_type: "worker-choice", prompt: "Continue", description: "Resume", load_skills: [] },
      unsafeTestValue({ sessionID: "ses_parent", messageID: "msg_parent", agent: "sisyphus", abort: new AbortController().signal }))
    expect(fetchSpy).not.toHaveBeenCalled()
  } finally {
    fetchSpy.mockRestore()
  }
})

test("named subagent_type dispatch bypasses Jev", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(reply([0.9, 0.9]))
  const launch = mock(async () => ({ id: "task-explore", sessionId: "ses_explore", status: "running" }))
  const delegate = createDelegateTask(unsafeTestValue({
    manager: { launch }, directory: "/tmp", userCategories: categories,
    jevRouting: { ...config, agent_ladders: { explore: { ladder: ["other", "another"], default: "other" } } },
    client: {
      app: { agents: async () => ({ data: [{ name: "explore", mode: "subagent", model: { providerID: "example", modelID: "high" } }] }) },
      config: { get: async () => ({ data: {} }) },
      session: { messages: async () => ({ data: [] }) },
    },
  }))
  try {
    await delegate.execute({ subagent_type: "explore", prompt: "Inspect", description: "Explore", run_in_background: true, load_skills: [] },
      unsafeTestValue({ sessionID: "ses_parent", messageID: "msg_parent", agent: "sisyphus", abort: new AbortController().signal }))
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ agent: "explore", model: expect.objectContaining({ modelID: "high" }) }))
  } finally {
    fetchSpy.mockRestore()
  }
})

describe("Jev named-agent ladders", () => {
  const agentConfig = JevRoutingConfigSchema.parse({
    mode: "active",
    agent_ladders: { worker: { ladder: ["cheap-agent", "strong-agent"], default: "strong-agent", suitability: { "cheap-agent": "Bounded tasks" } } },
  })
  const agents = [
    { name: "cheap-agent", mode: "subagent", description: "Cheap configured description", model: { providerID: "example", modelID: "low" } },
    { name: "strong-agent", mode: "subagent", description: "Hard work", model: { providerID: "example", modelID: "high" } },
  ]
  const context = { config: agentConfig, client: unsafeTestValue<ExecutorContext["client"]>({ app: { agents: async () => ({ data: agents }) } }), directory: "/tmp" }
  let fetchSpy: ReturnType<typeof spyOn>
  beforeEach(() => { fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(reply([0.8, 0.9])) })
  afterEach(() => fetchSpy.mockRestore())

  test("selects each agent based on scores and sends descriptions without models", async () => {
    expect(await selectAgentWithJev("worker", "Simple", context)).toBe("cheap-agent")
    fetchSpy.mockResolvedValue(reply([0.2, 0.8]))
    expect(await selectAgentWithJev("worker", "HARD_TASK", context)).toBe("strong-agent")
    const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body)
    expect(body.questions.tier_0.instructions).toContain("Bounded tasks")
    expect(body.questions.tier_1.instructions).toContain("Hard work")
    expect(fetchSpy.mock.calls[0]?.[1]?.body).not.toContain("example/low")
  })

  test("bypasses or defaults on failures and nonqualifying scores", async () => {
    expect(await selectAgentWithJev("worker", "Simple", { ...context, config: { ...agentConfig, mode: "off" } })).toBe("strong-agent")
    expect(await selectAgentWithJev("worker", "Simple", { ...context, modelRouting: false })).toBe("strong-agent")
    expect(fetchSpy).not.toHaveBeenCalled()
    for (const response of [reply([0.1, 0.2]), reply([0.9]), new Response("failure", { status: 503 })]) {
      fetchSpy.mockResolvedValue(response)
      expect(await selectAgentWithJev("worker", "Simple", context)).toBe("strong-agent")
    }
    fetchSpy.mockResolvedValue(reply([0.9, 0.9]))
    expect(await selectAgentWithJev("worker", "Simple", { ...context, config: { ...agentConfig, mode: "observe" } })).toBe("strong-agent")
    fetchSpy.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1)))
    expect(await selectAgentWithJev("worker", "Simple", context)).toBe("strong-agent")
  })

  test("invalid aliases, entries and defaults never call Jev", async () => {
    for (const [alias, ladder] of [
      ["cheap-agent", ["cheap-agent", "strong-agent"]],
      ["quick", ["cheap-agent", "strong-agent"]],
      ["worker", ["__proto__", "strong-agent"]],
      ["worker", ["missing", "strong-agent"]],
      ["worker", ["cheap-agent", "strong-agent"]],
    ] as const) {
      const next = { ...context, config: { ...agentConfig, agent_ladders: { [alias]: { ladder: [...ladder], default: "strong-agent" } } },
        categories: { quick: { description: "Category" } },
        ...(ladder[0] === "cheap-agent" && alias === "worker" ? { disabledAgents: ["cheap-agent"] } : {}) }
      expect(await selectAgentWithJev(alias, "Simple", next)).toBe(alias === "cheap-agent" ? "cheap-agent" : "strong-agent")
    }
    expect(await selectAgentWithJev("worker", "Simple", { ...context, config: { ...agentConfig, agent_ladders: { worker: { ladder: ["cheap-agent", "strong-agent"], default: "__proto__" } } } })).toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test.each([
    { callReasoning: undefined, expectedReasoning: "medium" },
    { callReasoning: "low", expectedReasoning: "low" },
    { callReasoning: "provider-custom", expectedReasoning: "provider-custom" },
  ])("task dispatch substitutes the real agent with reasoning $expectedReasoning", async ({ callReasoning, expectedReasoning }) => {
    const launch = mock(async () => ({ id: "task-worker", sessionId: "ses_worker", status: "running" }))
    const delegate = createDelegateTask(unsafeTestValue({
      manager: { launch }, directory: "/tmp", jevRouting: agentConfig,
      agentOverrides: { "cheap-agent": { model: "example/low", reasoning: "medium" } },
      availableSubagentNames: ["cheap-agent", "strong-agent"],
      client: { app: context.client.app, config: { get: async () => ({ data: {} }) }, session: { messages: async () => ({ data: [] }) } },
    }))
    // given/when: an alias chooses the configured agent, optionally with a call override
    await delegate.execute({ subagent_type: "worker", reasoning: callReasoning, prompt: "Simple", run_in_background: true, load_skills: [] },
      unsafeTestValue({ sessionID: "ses_parent", messageID: "msg_parent", agent: "sisyphus", abort: new AbortController().signal }))
    // then: the real agent's effort or the explicit override reaches background launch
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ agent: "cheap-agent", model: expect.objectContaining({ modelID: "low", reasoning: expectedReasoning }) }))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test("team named member resolves the alias to the effective agent", async () => {
    const member = unsafeTestValue<Parameters<typeof resolveMember>[0]>({ kind: "subagent_type", name: "worker-one", subagent_type: "worker", prompt: "Simple" })
    const ctx: ExecutorContext = {
      ...context,
      manager: {} as ExecutorContext["manager"],
      client: unsafeTestValue({ app: { agents: async () => ({ data: [
        { name: "atlas", mode: "subagent", model: { providerID: "example", modelID: "low" } },
        { name: "sisyphus-junior", mode: "subagent", model: { providerID: "example", modelID: "high" } },
      ] }) }, model: { list: async () => ({ data: [] }) } }),
      jevRouting: { ...agentConfig, agent_ladders: { worker: { ladder: ["sisyphus-junior", "atlas"], default: "atlas" } } },
    }
    const resolved = await resolveMember(member, ctx, "")
    expect(resolved.agentToUse).toBe("sisyphus-junior")
  })
})
