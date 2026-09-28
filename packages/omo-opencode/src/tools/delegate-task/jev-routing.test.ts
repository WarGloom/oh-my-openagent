import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
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
import type { ExecutorContext } from "./executor-types"
import { selectCategoryTierWithJev, type JevRoutingInput } from "./jev-routing"

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
    ]) {
      // when: the configuration is examined
      expect(await selectCategoryTierWithJev(input(override as Partial<JevRoutingInput>))).toBe("strong")
    }
    // then: invalid default cannot dispatch
    expect(await selectCategoryTierWithJev(input({ config: { ...config, default: "missing" } }))).toBeUndefined()
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
