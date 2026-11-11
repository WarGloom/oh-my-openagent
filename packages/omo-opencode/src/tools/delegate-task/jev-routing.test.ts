import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OhMyOpenCodeConfigSchema } from "../../config/schema"
import { JevRoutingConfigSchema } from "../../config/schema/jev-routing"
import { loadOmoOpenCodeConfigChain } from "../../plugin-config/omo-config-chain"
import { selectAgentWithJev, selectCategoryTierWithJev, type JevRoutingInput } from "./jev-routing"
import { categoryReply, frozenVectors } from "./jev-router.test-support"
import { MODEL } from "./jev-router-model"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { resolveMember } from "../../features/team-mode/team-runtime/resolve-member"
import type { ExecutorContext } from "./executor-types"
import { createDelegateTask } from "./tools"
import * as ledger from "./jev-routing-ledger"
import * as health from "../../shared/jev-routing-health"
import { PG_ARTIFACT, ROLLBACK_ARTIFACT } from "./jev-router-artifacts"

const config = JevRoutingConfigSchema.parse({ mode: "active", default: "unspecified-low" })
const categories = {
  "unspecified-low": {},
  "visual-engineering": { models: ["example/visual"] },
  writing: {},
  "deep-low": {},
}
function input(overrides: Partial<JevRoutingInput> = {}): JevRoutingInput {
  return {
    brief: "Implement the bounded change",
    description: "Bounded change",
    config,
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

describe("Jev frozen category routing", () => {
  let fetchSpy: ReturnType<typeof spyOn>
  let directory: string
  let ledgerSpy: ReturnType<typeof spyOn>
  let warningSpy: ReturnType<typeof spyOn>
  const originalKey = process.env.TYPESAFE_API_KEY
  const originalData = process.env.XDG_DATA_HOME
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "jev-routing-"))
    process.env.XDG_DATA_HOME = directory
    delete process.env.TYPESAFE_API_KEY
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(categoryReply()))
    ledgerSpy = spyOn(ledger, "recordJevRouting").mockResolvedValue(undefined)
    warningSpy = spyOn(health, "warnJevRouting").mockResolvedValue(undefined)
  })
  afterEach(() => {
    fetchSpy.mockRestore()
    ledgerSpy.mockRestore()
    warningSpy.mockRestore()
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = originalKey
    if (originalData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = originalData
    rmSync(directory, { recursive: true, force: true })
  })

  test("selects top-1 with the frozen questions and sanitized study state", async () => {
    expect(
      await selectCategoryTierWithJev(input({ brief: "Inspect /home/private/repo/source.ts and repair it" })),
    ).toBe("visual-engineering")
    const [url, init] = fetchSpy.mock.calls[0] ?? []
    expect(url).toBe("https://opencode.ai/zen/v1/systemone")
    expect(init.redirect).toBe("error")
    const body = JSON.parse(init.body)
    expect(body.model).toBe(MODEL)
    expect(body.state.task).toEqual({ title: "Bounded change", prompt: "Inspect source.ts and repair it" })
    expect(Object.keys(body.questions)).toHaveLength(14)
    expect(new Headers(init.headers).has("authorization")).toBe(false)
  })

  test("uses TypeSafe credentials and an explicit model override", async () => {
    process.env.TYPESAFE_API_KEY = "test-key"
    fetchSpy.mockResolvedValue(Response.json({ ...categoryReply(), model: "jev-explicit" }))
    expect(await selectCategoryTierWithJev(input({ config: { ...config, model: "jev-explicit" } }))).toBe(
      "visual-engineering",
    )
    const [url, init] = fetchSpy.mock.calls[0] ?? []
    expect(url).toBe("https://api.typesafe.ai/v1/systemone")
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-key")
    expect(JSON.parse(init.body).model).toBe("jev-explicit")
  })

  test("observes auto without changing the configured default", async () => {
    expect(await selectCategoryTierWithJev(input({ config: { ...config, mode: "observe" } }))).toBe("unspecified-low")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test("selects top-1 even below the old suitability threshold", async () => {
    fetchSpy.mockResolvedValue(Response.json(categoryReply(frozenVectors[2].vector)))
    expect(await selectCategoryTierWithJev(input({ config: { ...config, min_suitability: 1 } }))).toBe("deep-low")
  })

  test("selects the rollback artifact and fails closed for unknown artifact IDs", async () => {
    expect(
      await selectCategoryTierWithJev(input({ config: { ...config, artifact_id: ROLLBACK_ARTIFACT.artifact_id } })),
    ).toBe("visual-engineering")
    expect(ledgerSpy).toHaveBeenLastCalledWith(expect.objectContaining({ artifact_id: ROLLBACK_ARTIFACT.artifact_id }))
    expect(await selectCategoryTierWithJev(input({ config: { ...config, artifact_id: "unknown" } }))).toBe(
      "unspecified-low",
    )
    expect(warningSpy).toHaveBeenCalledWith("unknown_artifacts")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(config.artifact_id).toBe(PG_ARTIFACT.artifact_id)
  })

  test("a pinned model mismatch falls back and increments its warning counter", async () => {
    fetchSpy.mockResolvedValue(Response.json({ ...categoryReply(), model: "jev-other" }))
    expect(await selectCategoryTierWithJev(input())).toBe("unspecified-low")
    expect(warningSpy).toHaveBeenCalledWith("model_mismatches")
    expect(ledgerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ error: "model_mismatch", jev_model_id: "jev-other" }),
    )
  })

  test.each([{ brief: "", status: "none", reason: "empty_prompt" }])(
    "would-block diagnostics remain ledger-only for $reason",
    async ({ brief, status, reason }) => {
      expect(await selectCategoryTierWithJev(input({ brief, directory }))).toBe("visual-engineering")
      expect(ledgerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          brief_status: status,
          would_block: true,
          reason_codes: expect.arrayContaining([reason]),
        }),
      )
      const state = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body).state
      expect(Object.keys(state)).toEqual(["task", "facts"])
      expect(state.task.brief_status).toBeUndefined()
      expect(state.task.would_block).toBeUndefined()
    },
  )

  test.each(["off", "bypass"])("%s uses the default without a request", async (mode) => {
    expect(
      await selectCategoryTierWithJev(
        input(mode === "off" ? { config: { ...config, mode: "off" } } : { modelRouting: false }),
      ),
    ).toBe("unspecified-low")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test.each(["missing", "auto", "__proto__", "constructor"])("rejects invalid default %s", async (fallback) => {
    expect(await selectCategoryTierWithJev(input({ config: { ...config, default: fallback } }))).toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test.each([
    ["HTTP", () => new Response("private body", { status: 503 })],
    ["missing answers", () => Response.json({ ...categoryReply(), answers: {} })],
    ["invalid JSON", () => new Response("private non-json")],
    ["unexpected model", () => Response.json({ ...categoryReply(), model: "other-version" })],
    ["oversized body", () => Response.json({ ...categoryReply(), padding: "x".repeat(65536) })],
  ])("falls back on %s", async (_name, response) => {
    fetchSpy.mockImplementation(async () => response())
    expect(await selectCategoryTierWithJev(input())).toBe("unspecified-low")
  })

  test("rejects streaming replies over the bound regardless of content-length", async () => {
    for (const length of [undefined, "2", "70000"]) {
      const cancel = mock(() => undefined)
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(70000))
          },
          cancel,
        }),
        length ? { headers: { "content-length": length } } : undefined,
      )
      fetchSpy.mockResolvedValueOnce(response)
      expect(await selectCategoryTierWithJev(input())).toBe("unspecified-low")
      expect(cancel).toHaveBeenCalledTimes(1)
    }
  })

  test("falls back on timeout and propagates tool cancellation", async () => {
    fetchSpy.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          if (init.signal?.aborted) {
            reject(new DOMException("aborted", "AbortError"))
            return
          }
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true,
          })
        }),
    )
    expect(await selectCategoryTierWithJev(input({ config: { ...config, timeout_ms: 100 } }))).toBe("unspecified-low")
    const controller = new AbortController()
    const pending = selectCategoryTierWithJev(input({ signal: controller.signal }))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  test.each([undefined, "writing"])(
    "parent lookup timeout is bounded for orchestrator category %s",
    async (orchestratorCategory) => {
      const timeoutMs = 100
      const nativeTimer = globalThis.setTimeout.bind(globalThis)
      const expire = Promise.withResolvers<() => void>()
      const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation((handler, timeout, ...args) => {
        const timer = nativeTimer(handler, timeout, ...args)
        if (timeout === timeoutMs) expire.resolve(() => handler(...args))
        return timer
      })
      const entered = Promise.withResolvers<void>()
      try {
        const pending = selectCategoryTierWithJev(
          input({
            orchestratorCategory,
            config: { ...config, timeout_ms: timeoutMs },
            resolveDirectory: async () => {
              entered.resolve()
              return new Promise(() => {})
            },
          }),
        )
        await entered.promise
        const timeout = await expire.promise
        timeout()
        expect(await pending).toBe(orchestratorCategory ?? "unspecified-low")
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(ledgerSpy).toHaveBeenCalledWith(
          expect.objectContaining({ error: "unavailable", chosen_category: orchestratorCategory ?? "unspecified-low" }),
        )
      } finally {
        timerSpy.mockRestore()
      }
    },
  )
})

test("Jev schema retains existing keys and bounds", () => {
  expect(JevRoutingConfigSchema.parse({ ladder: ["quick", "deep"], default: "quick" })).toMatchObject({
    mode: "off",
    timeout_ms: 2000,
    min_suitability: 0.6,
    model: "jev-latest",
    api_key_env: "TYPESAFE_API_KEY",
  })
  for (const invalid of [
    { ladder: ["quick"], default: "quick" },
    { ladder: Array(9).fill("quick"), default: "quick" },
    { default: "quick", timeout_ms: 99 },
    { default: "quick", min_suitability: 1.1 },
    { default: "quick", categories: {} },
  ])
    expect(JevRoutingConfigSchema.safeParse(invalid).success).toBe(false)
})

test("global opencode Jev settings survive the unified loader", () => {
  const home = mkdtempSync(join(tmpdir(), "omo-jev-config-"))
  try {
    mkdirSync(join(home, ".omo"))
    writeFileSync(
      join(home, ".omo", "omo.jsonc"),
      JSON.stringify({ "[opencode]": { jev_routing: config, categories } }),
    )
    const chain = loadOmoOpenCodeConfigChain(home, { HOME: home })
    const parsed = OhMyOpenCodeConfigSchema.parse(Object.assign({}, ...chain.views.map((view) => view.config)))
    expect(parsed.jev_routing?.default).toBe("unspecified-low")
    expect(parsed.categories?.["visual-engineering"]?.models).toEqual(["example/visual"])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

describe("Jev named-agent ladders", () => {
  const agentConfig = JevRoutingConfigSchema.parse({
    mode: "active",
    agent_ladders: {
      worker: {
        ladder: ["cheap-agent", "strong-agent"],
        default: "strong-agent",
        suitability: { "cheap-agent": "Bounded tasks" },
      },
    },
  })
  const agents = [
    {
      name: "cheap-agent",
      mode: "subagent",
      description: "Cheap configured description",
      model: { providerID: "example", modelID: "low" },
    },
    {
      name: "strong-agent",
      mode: "subagent",
      description: "Hard work",
      model: { providerID: "example", modelID: "high" },
    },
  ]
  const context = {
    config: agentConfig,
    client: unsafeTestValue<ExecutorContext["client"]>({ app: { agents: async () => ({ data: agents }) } }),
    directory: "/tmp",
  }
  let fetchSpy: ReturnType<typeof spyOn>
  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(reply([0.8, 0.9]))
  })
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
    expect(await selectAgentWithJev("worker", "Simple", { ...context, config: { ...agentConfig, mode: "off" } })).toBe(
      "strong-agent",
    )
    expect(await selectAgentWithJev("worker", "Simple", { ...context, modelRouting: false })).toBe("strong-agent")
    expect(fetchSpy).not.toHaveBeenCalled()
    for (const response of [reply([0.1, 0.2]), reply([0.9]), new Response("failure", { status: 503 })]) {
      fetchSpy.mockResolvedValue(response)
      expect(await selectAgentWithJev("worker", "Simple", context)).toBe("strong-agent")
    }
    fetchSpy.mockResolvedValue(reply([0.9, 0.9]))
    expect(
      await selectAgentWithJev("worker", "Simple", { ...context, config: { ...agentConfig, mode: "observe" } }),
    ).toBe("strong-agent")
    fetchSpy.mockRejectedValue(new Error("timeout"))
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
      const next = {
        ...context,
        config: { ...agentConfig, agent_ladders: { [alias]: { ladder: [...ladder], default: "strong-agent" } } },
        categories: { quick: { description: "Category" } },
        ...(ladder[0] === "cheap-agent" && alias === "worker" ? { disabledAgents: ["cheap-agent"] } : {}),
      }
      expect(await selectAgentWithJev(alias, "Simple", next)).toBe(
        alias === "cheap-agent" ? "cheap-agent" : "strong-agent",
      )
    }
    expect(
      await selectAgentWithJev("worker", "Simple", {
        ...context,
        config: {
          ...agentConfig,
          agent_ladders: { worker: { ladder: ["cheap-agent", "strong-agent"], default: "__proto__" } },
        },
      }),
    ).toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test.each([
    { callReasoning: undefined, expectedReasoning: "medium" },
    { callReasoning: "low", expectedReasoning: "low" },
    { callReasoning: "provider-custom", expectedReasoning: "provider-custom" },
  ])(
    "task dispatch substitutes the real agent with reasoning $expectedReasoning",
    async ({ callReasoning, expectedReasoning }) => {
      const launch = mock(async () => ({ id: "task-worker", sessionId: "ses_worker", status: "running" }))
      const delegate = createDelegateTask(
        unsafeTestValue({
          manager: { launch },
          directory: "/tmp",
          jevRouting: agentConfig,
          agentOverrides: { "cheap-agent": { model: "example/low", reasoning: "medium" } },
          availableSubagentNames: ["cheap-agent", "strong-agent"],
          client: {
            app: context.client.app,
            config: { get: async () => ({ data: {} }) },
            session: { messages: async () => ({ data: [] }) },
          },
        }),
      )
      await delegate.execute(
        {
          subagent_type: "worker",
          reasoning: callReasoning,
          prompt: "Simple",
          run_in_background: true,
          load_skills: [],
        },
        unsafeTestValue({
          sessionID: "ses_parent",
          messageID: "msg_parent",
          agent: "sisyphus",
          abort: new AbortController().signal,
        }),
      )
      expect(launch).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: "cheap-agent",
          model: expect.objectContaining({ modelID: "low", reasoning: expectedReasoning }),
        }),
      )
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    },
  )

  test("team named member resolves the alias to the effective agent", async () => {
    const member = unsafeTestValue<Parameters<typeof resolveMember>[0]>({
      kind: "subagent_type",
      name: "worker-one",
      subagent_type: "worker",
      prompt: "Simple",
    })
    const ctx: ExecutorContext = {
      ...context,
      manager: unsafeTestValue({}),
      client: unsafeTestValue({
        app: {
          agents: async () => ({
            data: [
              { name: "atlas", mode: "subagent", model: { providerID: "example", modelID: "low" } },
              { name: "sisyphus-junior", mode: "subagent", model: { providerID: "example", modelID: "high" } },
            ],
          }),
        },
        model: { list: async () => ({ data: [] }) },
      }),
      jevRouting: {
        ...agentConfig,
        agent_ladders: { worker: { ladder: ["sisyphus-junior", "atlas"], default: "atlas" } },
      },
    }
    expect((await resolveMember(member, ctx, "")).agentToUse).toBe("sisyphus-junior")
  })
})
