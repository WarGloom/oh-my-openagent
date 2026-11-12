import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { JevRoutingConfigSchema } from "../../config/schema/jev-routing"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { createDelegateTask } from "./tools"
import type { DelegateTaskToolOptions } from "./types"

const active = JevRoutingConfigSchema.parse({ mode: "active", timeout_ms: 100 })
const skills = ["alpha", "blocked", "beta"].map((name) => ({
  name,
  description: `Guidance for ${name}`,
  location: `skill://${name}/SKILL.md`,
  content: "PRIVATE SKILL BODY",
}))

function fixture(mode: "active" | "observe" | "off" = "active") {
  const launches: string[][] = []
  const manager = {
    nativeJobs: {},
    async launch(input: { skills: string[] }) {
      launches.push(input.skills)
      return { id: "bg_test", sessionId: "ses_child", status: "pending", description: "Test task", agent: "explore" }
    },
  }
  const client = {
    app: { agents: async () => ({ data: [{ name: "explore", mode: "subagent" }] }) },
    config: { get: async () => ({ data: { model: "openai/test" } }) },
    session: { messages: async () => ({ data: [] }) },
  }
  const task = createDelegateTask(
    unsafeTestValue<DelegateTaskToolOptions>({
      manager,
      client,
      directory: "/project",
      jevRouting: { ...active, mode },
      nativeSkills: { all: async () => skills },
      disabledSkills: new Set(["blocked"]),
      connectedProvidersOverride: ["openai"],
      availableModelsOverride: new Set(["openai/test"]),
      agentOverrides: { explore: { model: "openai/test" } },
    }),
  )
  const execute = (selection: Record<string, unknown> = {}) =>
    task.execute(
      unsafeTestValue({
        description: "Review the task",
        prompt: "Review TypeScript changes; do not install dependencies.",
        subagent_type: "explore",
        run_in_background: true,
        ...selection,
      }),
      unsafeTestValue({
        sessionID: "ses_parent",
        messageID: "msg_parent",
        callID: "call_test",
        agent: "sisyphus",
        abort: new AbortController().signal,
      }),
    )
  return { execute, launches }
}

function reply(scores: number[]) {
  return Response.json({
    model: "jev-test",
    answers: Object.fromEntries(scores.map((score, index) => [`tier_${index}`, { type: "noul", noul: score }])),
  })
}

describe("delegate skill suggestions", () => {
  afterEach(() => {
    mock.restore()
  })

  test.each([
    { scores: [0.9, 0.8], expected: ["alpha", "beta"] },
    { scores: [0.1, 0.2], expected: [] },
  ])("selects only fitting enabled skills", async ({ scores, expected }) => {
    let request = ""
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      request = String(init?.body)
      return reply(scores)
    })
    const { execute, launches } = fixture()
    await execute()
    expect(launches).toEqual([expected])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(request).not.toContain("blocked")
    expect(request).not.toContain("PRIVATE SKILL BODY")
    const state = JSON.parse(request).state
    expect(state).toContain("Review the task")
    expect(state).toContain("TypeScript")
    expect(state).toContain("do not install dependencies")
    fetchMock.mockRestore()
  })

  test.each([{ load_skills: [] }, { load_skills: ["beta"] }])("preserves explicit selections", async (selection) => {
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Unexpected request")
    })
    const { execute, launches } = fixture()
    await execute(selection)
    expect(launches).toEqual([selection.load_skills])
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockRestore()
  })

  test("bounds and sanitizes supplied task context before selection", async () => {
    let request = ""
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      request = String(init?.body)
      return reply([0.9, 0.1])
    })
    const { execute, launches } = fixture()
    await execute({ prompt: `TypeScript api_key=synthetic-secret ${"\u{1F9EA} ".repeat(4000)}` })
    const state = JSON.parse(request).state
    expect(Buffer.byteLength(state)).toBeLessThanOrEqual(8192)
    expect(state).toContain("TypeScript")
    expect(state).not.toContain("synthetic-secret")
    expect(launches).toEqual([["alpha"]])
    fetchMock.mockRestore()
  })

  test.each(["off", "observe"] as const)("does not infer skills in %s mode", async (mode) => {
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Unexpected request")
    })
    const { execute, launches } = fixture(mode)
    await execute()
    expect(launches).toEqual([[]])
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockRestore()
  })

  test("does not infer skills when model routing is disabled", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Unexpected request")
    })
    const { execute, launches } = fixture()
    await execute({ model_routing: false })
    expect(launches).toEqual([[]])
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockRestore()
  })

  test.each([
    ["http", () => new Response(null, { status: 503 })],
    ["invalid", () => Response.json({ model: "jev-test", answers: {} })],
    [
      "unknown ID",
      () =>
        Response.json({
          model: "jev-test",
          answers: { tier_0: { type: "noul", noul: 0.9 }, tier_99: { type: "noul", noul: 0.9 } },
        }),
    ],
  ])("continues delegation without skills after %s", async (_name, response) => {
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => response())
    const { execute, launches } = fixture()
    await execute()
    expect(launches).toEqual([[]])
    fetchMock.mockRestore()
  })

  test("continues delegation after a service timeout", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError")), {
            once: true,
          })
        }),
    )
    const { execute, launches } = fixture()
    await execute()
    expect(launches).toEqual([[]])
    fetchMock.mockRestore()
  })

  test("continues delegation when the service is unavailable", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(new Error("unavailable"))
    const { execute, launches } = fixture()
    await execute()
    expect(launches).toEqual([[]])
    fetchMock.mockRestore()
  })
})
