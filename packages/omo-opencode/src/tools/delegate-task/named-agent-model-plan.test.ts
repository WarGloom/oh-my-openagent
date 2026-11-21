import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { JevRoutingConfigSchema } from "../../config/schema/jev-routing"
import { briefTier } from "./named-agent-brief-judgments"
import { planNamedAgentModels } from "./named-agent-model-plan"

const primary = "paid/primary"
const candidate = "other/candidate"
const last = "third/last"
const config = JevRoutingConfigSchema.parse({
  mode: "active",
  named_agent_tiers: { audit: { role: "Audit graph evidence.", lighter: primary, stronger: candidate } },
})
const options = {
  agent: "audit",
  brief: "Compare the two audit results.",
  config,
  chain: [primary, candidate, last],
  available: new Set([primary, candidate, last]),
}
const reply = () =>
  Response.json({
    model: "jev-test",
    answers: {
      unknown_cause: { type: "noul", noul: 0.71 },
      cross_component: { type: "noul", noul: 0.1 },
      open_decision: { type: "noul", noul: 0.1 },
      specified_method: { type: "noul", noul: 0.9 },
    },
  })
afterEach(() => {
  spyOn(globalThis, "fetch").mockRestore()
})

describe("named agent model plan", () => {
  test("moves the stronger rung to the head on an unknown cause and preserves the retry order", async () => {
    const transport = spyOn(globalThis, "fetch").mockImplementation(async () => reply())
    const plan = await planNamedAgentModels(options)
    expect(plan?.decision.named_model?.request_payload).toBe(transport.mock.calls[0]?.[1]?.body)
    expect(plan?.models).toEqual([candidate, primary, last])
    expect(plan?.decision).toMatchObject({
      answers: { unknown_cause: 0.71, cross_component: 0.1, open_decision: 0.1, specified_method: 0.9 },
      named_model: {
        agent: "audit",
        selected_model: candidate,
        action: "automatic",
        fallback_plan: [primary, last],
      },
    })
  })

  test("keeps the configured default when Jev is unavailable", async () => {
    spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 503 }))
    const plan = await planNamedAgentModels(options)
    expect(plan?.models).toEqual([primary, candidate, last])
    expect(plan?.decision).toMatchObject({
      error: "http_error",
      named_model: { selected_model: primary, action: "default" },
    })
  })

  test("does not send a brief for an undeclared agent", async () => {
    const transport = spyOn(globalThis, "fetch").mockImplementation(async () => reply())
    expect(await planNamedAgentModels({ ...options, agent: "unlisted" })).toBeUndefined()
    expect(transport).not.toHaveBeenCalled()
  })

  test("does not admit the unavailable primary when the configured alternate is available", async () => {
    const transport = spyOn(globalThis, "fetch").mockImplementation(async () => reply())
    const plan = await planNamedAgentModels({ ...options, available: new Set([candidate, last]) })
    expect(plan?.models).toEqual([candidate, primary, last])
    expect(plan?.decision.named_model?.action).toBe("default")
    expect(transport).not.toHaveBeenCalled()
  })
})

test.each([
  { unknown_cause: 0.3, cross_component: 0.3, open_decision: 0.3, specified_method: 0.7, tier: "lighter" },
  { unknown_cause: 0.31, cross_component: 0, open_decision: 0, specified_method: 1, tier: "stronger" },
  { unknown_cause: 0, cross_component: 0.31, open_decision: 0, specified_method: 1, tier: "stronger" },
  { unknown_cause: 0, cross_component: 0, open_decision: 0.31, specified_method: 1, tier: "stronger" },
  { unknown_cause: 0, cross_component: 0, open_decision: 0, specified_method: 0.69, tier: "stronger" },
] as const)("routes probability boundaries to $tier", ({ tier, ...scores }) => {
  expect(briefTier(scores)).toBe(tier)
})

test("does not truncate an oversized brief or send it externally", async () => {
  const transport = spyOn(globalThis, "fetch").mockImplementation(async () => reply())
  const plan = await planNamedAgentModels({ ...options, brief: "a".repeat(8193) })
  expect(transport).not.toHaveBeenCalled()
  expect(plan?.decision).toMatchObject({
    error: "oversized_request",
    answers: null,
    named_model: { action: "default", skip_reason: "oversized_request" },
  })
  expect(plan?.decision.named_model?.request_payload).toBeUndefined()
})
