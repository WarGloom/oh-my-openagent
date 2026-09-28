import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { OhMyOpenCodeConfigSchema } from "../../config/schema"
import { JevRoutingConfigSchema } from "../../config/schema/jev-routing"
import { loadOmoOpenCodeConfigChain } from "../../plugin-config/omo-config-chain"
import * as providerCache from "../../shared/connected-providers-cache"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { resolveCategoryExecution } from "./category-resolver"
import type { ExecutorContext } from "./executor-types"
import { selectCategoryModelWithJev, type JevRoutingInput } from "./jev-routing"
import { createDelegateTask } from "./tools"

const models = [
  { model: "example/low", reasoning: "low", variant: "small" },
  { model: "example/high", reasoning: "high", variant: "large" },
] as const
const config = JevRoutingConfigSchema.parse({
    mode: "active",
    categories: {
      custom: [
        { model: "example/low", suitability: "simple work" },
        { model: "example/high", suitability: "hard work" },
      ],
    },
})

function input(overrides: Partial<JevRoutingInput> = {}): JevRoutingInput {
  return {
    category: "custom",
    brief: "Implement the bounded change",
    config,
    canonicalModels: models,
    usableModels: models,
    availableModels: new Set(["example/low", "example/high"]),
    ...overrides,
  }
}

function reply(scores: readonly number[], overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    model: "jev-1.13.0",
    answers: Object.fromEntries(scores.map((score, index) => [`candidate_${index}`, { type: "noul", noul: score }])),
    ...overrides,
  })
}

describe("Jev category routing", () => {
  let fetchSpy: ReturnType<typeof spyOn>
  let previousApiKey: string | undefined

  beforeEach(() => {
    previousApiKey = process.env.OPENCODE_API_KEY
    process.env.OPENCODE_API_KEY = "test-only-key"
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(reply([0.2, 0.95]))
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    if (previousApiKey === undefined) delete process.env.OPENCODE_API_KEY
    else process.env.OPENCODE_API_KEY = previousApiKey
  })

  test("selects the first suitable declared candidate and sends only the bounded Jev request", async () => {
    // given: two canonical, available entries ordered by preference
    // when: Jev rates only the second above threshold
    const selected = await selectCategoryModelWithJev(input())
    // then: the selected entry is the original configured object and wire contract is fixed
    expect(selected).toBe(models[1])
    const [url, init] = fetchSpy.mock.calls[0] ?? []
    expect(url).toBe("https://opencode.ai/zen/v1/systemone")
    expect(init).toMatchObject({ method: "POST", redirect: "error" })
    expect(init.headers).toEqual({ "content-type": "application/json" })
    const body = z.object({
      model: z.string(), state: z.string(),
      questions: z.record(z.string(), z.object({
        instructions: z.string(), criteria: z.object({ true: z.string() }),
      })),
    }).parse(JSON.parse(init?.body))
    expect(body).toMatchObject({ model: "jev-1.13-free", state: "Implement the bounded change" })
    expect(Object.keys(body.questions)).toEqual(["candidate_0", "candidate_1"])
    expect(body.questions.candidate_0.instructions).toContain("candidate 0 (example/low)")
    expect(body.questions.candidate_1.criteria.true).toBe("hard work")
  })

  test("routes anonymously when no API key is set", async () => {
    // given: the free endpoint needs no credentials
    delete process.env.OPENCODE_API_KEY
    // when: the classifier selects a suitable candidate
    const selected = await selectCategoryModelWithJev(input())
    // then: routing works without an authorization header
    expect(selected).toBe(models[1])
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toEqual({ "content-type": "application/json" })
  })

  test("keeps original selection in observe, off and oversized-brief modes", async () => {
    // given: explicit opt-in and bypass conditions
    const observed = { ...config, mode: "observe" as const }
    // when: each boundary is evaluated
    expect(await selectCategoryModelWithJev(input({ config: observed }))).toBeUndefined()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(await selectCategoryModelWithJev(input({ config: { ...config, mode: "off" } }))).toBeUndefined()
    expect(await selectCategoryModelWithJev(input({ brief: "x".repeat(8193) }))).toBeUndefined()
    // then: only observe issued a request
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test.each([
    ["missing answer", reply([0.95])],
    ["out-of-range score", reply([0.5, 1.2])],
    ["extra answer", reply([0.5, 0.9, 0.9])],
    ["unknown answer type", reply([], { answers: { candidate_0: { type: "confidence", confidence: 1 }, candidate_1: { type: "noul", noul: 1 } } })],
  ])("keeps original routing when response has %s", async (_name, response) => {
    // given: an invalid response boundary
    fetchSpy.mockResolvedValue(response)
    // when: selection is requested
    const selected = await selectCategoryModelWithJev(input())
    // then: no candidate is selected
    expect(selected).toBeUndefined()
  })

  test("keeps original routing on no suitable score, HTTP error or timeout", async () => {
    // given: a service unavailable or ineligible response
    fetchSpy.mockResolvedValueOnce(reply([0.2, 0.8])).mockResolvedValueOnce(new Response("private body", { status: 503 }))
    // when: requests complete or time out
    expect(await selectCategoryModelWithJev(input())).toBeUndefined()
    expect(await selectCategoryModelWithJev(input())).toBeUndefined()
    fetchSpy.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")), { once: true })
    }))
    expect(await selectCategoryModelWithJev(input({ config: { ...config, timeout_ms: 100 } }))).toBeUndefined()
  })

  test("does not call Jev for an outside-chain, unavailable or single-model candidate", async () => {
    // given: categories that cannot safely reroute
    const outside = { ...config, categories: { custom: [{ model: "example/alien", suitability: "x" }, config.categories.custom[1]] } }
    // when: candidate membership or availability is insufficient
    expect(await selectCategoryModelWithJev(input({ config: outside }))).toBeUndefined()
    expect(await selectCategoryModelWithJev(input({ availableModels: new Set(["example/low"]) }))).toBeUndefined()
    expect(await selectCategoryModelWithJev(input({ canonicalModels: models.slice(0, 1) }))).toBeUndefined()
    // then: no classifier request was sent
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test("propagates tool cancellation instead of failing open", async () => {
    // given: a pending classifier call and tool cancellation
    const controller = new AbortController()
    fetchSpy.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true })
    }))
    // when: the parent aborts while Jev is pending
    const pending = selectCategoryModelWithJev(input({ signal: controller.signal }))
    controller.abort()
    // then: selection rejects; a worker must not spawn
    const settled = await Promise.allSettled([pending])
    expect(settled[0]).toMatchObject({ status: "rejected", reason: { name: "AbortError" } })
  })
})

test("Jev candidate schema accepts nested model IDs without accepting empty segments", () => {
  // given: a nested model ID used in an existing provider chain
  const candidates = [
    { model: "openrouter/deepseek/deepseek-v4-flash-0731:free", suitability: "routine work" },
    { model: "example/strong", suitability: "complex work" },
  ]
  // when: the candidate list crosses the config boundary
  const parsed = JevRoutingConfigSchema.safeParse({ categories: { custom: candidates } })
  // then: the exact nested ID survives and an empty model segment is refused
  expect(parsed.success && parsed.data.categories.custom[0]?.model).toBe(candidates[0]?.model)
  expect(JevRoutingConfigSchema.safeParse({ categories: { custom: [{ ...candidates[0], model: "openrouter//deepseek" }, candidates[1]] } }).success).toBe(false)
})

test("global [opencode] Jev config survives the unified loader", () => {
  // given: a global-only config file with Jev routing
  const home = mkdtempSync(join(tmpdir(), "omo-jev-config-"))
  try {
    mkdirSync(join(home, ".omo"))
    writeFileSync(join(home, ".omo", "omo.jsonc"), JSON.stringify({ "[opencode]": { jev_routing: config } }))
    // when: the normal OpenCode view is loaded
    const chain = loadOmoOpenCodeConfigChain(home, { HOME: home })
    const parsed = OhMyOpenCodeConfigSchema.parse(Object.assign({}, ...chain.views.map((view) => view.config)))
    // then: the routing mode and candidate order survive
    expect(parsed.jev_routing?.mode).toBe("active")
    expect(parsed.jev_routing?.categories.custom.map((candidate) => candidate.model)).toEqual(["example/low", "example/high"])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("category resolver reroutes the same role and preserves entry settings and fallback order", async () => {
  // given: two available canonical models and a classifier decision for the second
  const previousApiKey = process.env.OPENCODE_API_KEY
  process.env.OPENCODE_API_KEY = "test-only-key"
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(reply([0.3, 0.98]))
  const cacheSpy = spyOn(providerCache, "readProviderModelsCache").mockReturnValue({
    connected: ["example"], models: { example: ["low", "high"] }, updatedAt: "2026-09-28",
  })
  try {
    const ctx: ExecutorContext = {
      client: { model: { list: async () => ({ data: [] }) } } as ExecutorContext["client"],
      manager: {} as ExecutorContext["manager"], directory: "/tmp",
      userCategories: { custom: { models: [...models] } }, jevRouting: config,
    }
    const args = { category: "custom", prompt: "Implement feature", description: "Feature", run_in_background: false, load_skills: [] }
    // when: active routing selects the second canonical entry
    const result = await resolveCategoryExecution(args, ctx, undefined, undefined)
    // then: the category agent, model-specific settings and remaining order persist
    expect(result.error).toBeUndefined()
    expect(result.agentToUse).toBe("Sisyphus-Junior")
    expect(result.actualModel).toBe("example/high")
    expect(result.categoryModel).toMatchObject({ providerID: "example", modelID: "high", variant: "large", reasoning: "high" })
    expect(result.fallbackChain?.map((entry) => entry.model)).toEqual(["low"])
    expect(await resolveCategoryExecution({ ...args, model_routing: false }, ctx, undefined, undefined)).toMatchObject({ actualModel: "example/low" })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  } finally {
    cacheSpy.mockRestore()
    fetchSpy.mockRestore()
    if (previousApiKey === undefined) delete process.env.OPENCODE_API_KEY
    else process.env.OPENCODE_API_KEY = previousApiKey
  }
})

test("task_id continuation bypasses classification even when its session is gone", async () => {
  // given: enabled Jev routing and a prior session id
  const previousApiKey = process.env.OPENCODE_API_KEY
  process.env.OPENCODE_API_KEY = "test-only-key"
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(reply([0.9, 0.9]))
  const manager = { resume: async () => ({ id: "task-1", sessionId: "ses_earlier", status: "running" }) }
  const client = {
    app: { agents: async () => ({ data: [] }) },
    config: { get: async () => ({ data: {} }) },
    session: {
      get: async () => ({ data: { directory: "/tmp" } }),
      messages: async () => ({ status: 404 }),
      status: async () => ({ data: { ses_earlier: { type: "idle" } } }),
      prompt: async () => ({ data: {} }), promptAsync: async () => ({ data: {} }),
    },
  }
  const delegate = createDelegateTask(unsafeTestValue({ manager, client, directory: "/tmp", jevRouting: config }))
  try {
    // when: continuing a prior task despite a category argument
    const result = await delegate.execute({ task_id: "ses_earlier", category: "custom", prompt: "Continue", description: "Resume", load_skills: [] },
      unsafeTestValue({ sessionID: "ses_parent", messageID: "msg_parent", agent: "sisyphus", abort: new AbortController().signal }))
    // then: the classifier was never asked to select a new model
    expect(result).toContain("no longer exists")
    expect(fetchSpy).not.toHaveBeenCalled()
  } finally {
    fetchSpy.mockRestore()
    if (previousApiKey === undefined) delete process.env.OPENCODE_API_KEY
    else process.env.OPENCODE_API_KEY = previousApiKey
  }
})

test("named subagent dispatch bypasses the category classifier", async () => {
  // given: enabled Jev routing and a named agent with a pinned model
  const previousApiKey = process.env.OPENCODE_API_KEY
  process.env.OPENCODE_API_KEY = "test-only-key"
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(reply([0.9, 0.9]))
  const launch = mock(async () => ({ id: "task-explore", sessionId: "ses_explore", status: "running" }))
  const delegate = createDelegateTask(unsafeTestValue({
    manager: { launch }, directory: "/tmp", jevRouting: config,
    client: {
      app: { agents: async () => ({ data: [{ name: "explore", mode: "subagent", model: { providerID: "example", modelID: "high" } }] }) },
      config: { get: async () => ({ data: {} }) },
      session: { messages: async () => ({ data: [] }) },
    },
  }))
  try {
    // when: a named agent is launched
    await delegate.execute({ subagent_type: "explore", prompt: "Inspect", description: "Explore", run_in_background: true, load_skills: [] },
      unsafeTestValue({ sessionID: "ses_parent", messageID: "msg_parent", agent: "sisyphus", abort: new AbortController().signal }))
    // then: the named agent keeps its pinned model without Jev
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ agent: "explore", model: expect.objectContaining({ modelID: "high" }) }))
  } finally {
    fetchSpy.mockRestore()
    if (previousApiKey === undefined) delete process.env.OPENCODE_API_KEY
    else process.env.OPENCODE_API_KEY = previousApiKey
  }
})
