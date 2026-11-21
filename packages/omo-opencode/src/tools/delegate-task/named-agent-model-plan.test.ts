import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { JevRoutingConfigSchema } from "../../config/schema/jev-routing"
import { planNamedAgentModels } from "./named-agent-model-plan"

const primary = "paid/primary"
const candidate = "other/candidate"
const last = "third/last"
const config = JevRoutingConfigSchema.parse({
  mode: "active",
  named_agent_models: { audit: { candidates: [primary, candidate] } },
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
    answers: { tier_0: { type: "noul", noul: 0.71 }, tier_1: { type: "noul", noul: 0.95 } },
  })
afterEach(() => {
  spyOn(globalThis, "fetch").mockRestore()
})

describe("named agent model plan", () => {
  test("moves the highest eligible candidate to the head and reports the actual retry order", async () => {
    spyOn(globalThis, "fetch").mockImplementation(async () => reply())
    const plan = await planNamedAgentModels(options)
    expect(plan?.models).toEqual([candidate, primary, last])
    expect(plan?.decision).toMatchObject({
      answers: { [primary]: 0.71, [candidate]: 0.95 },
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
