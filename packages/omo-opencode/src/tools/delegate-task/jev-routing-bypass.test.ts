import { expect, mock, spyOn, test } from "bun:test"
import { createDelegateTask } from "./tools"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { JevRoutingConfigSchema } from "../../config/schema/jev-routing"

const routing = JevRoutingConfigSchema.parse({
  mode: "active",
  default: "unspecified-low",
  agent_ladders: { "worker-choice": { ladder: ["cheap-agent", "strong-agent"], default: "strong-agent" } },
})

test.each([
  { name: "auto", selection: { category: "auto" } },
  { name: "omitted", selection: {} },
  { name: "alias", selection: { subagent_type: "worker-choice" } },
])("task_id continuation bypasses Jev with $name selection", async ({ name, selection }) => {
  const session = `ses_earlier_${name}`
  const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Classifier must not run"))
  const promptAsync = mock(async () => ({ data: {} }))
  const priorUser = { info: { id: "msg_1", role: "user" }, parts: [{ type: "text", text: "Earlier request" }] }
  const prior = {
    info: {
      id: "msg_2",
      role: "assistant",
      agent: "Sisyphus-Junior",
      model: { providerID: "example", modelID: "low" },
      finish: "stop",
    },
    parts: [{ type: "text", text: "Earlier answer" }],
  }
  const continuationUser = { info: { id: "msg_3", role: "user" }, parts: [{ type: "text", text: "Continue" }] }
  const continued = {
    info: {
      id: "msg_4",
      role: "assistant",
      agent: "Sisyphus-Junior",
      model: { providerID: "example", modelID: "low" },
      finish: "stop",
    },
    parts: [{ type: "text", text: "Continued answer" }],
  }
  const client = {
    app: { agents: async () => ({ data: [] }) },
    config: { get: async () => ({ data: {} }) },
    session: {
      get: async () => ({ data: { id: session, parentID: "ses_parent", directory: process.cwd() } }),
      messages: async () => ({
        data: promptAsync.mock.calls.length ? [priorUser, prior, continuationUser, continued] : [priorUser, prior],
      }),
      status: async () => ({ data: { [session]: { type: "idle" } } }),
      promptAsync,
      abort: async () => ({ data: {} }),
    },
  }
  const delegate = createDelegateTask(
    unsafeTestValue({ manager: {}, client, directory: process.cwd(), jevRouting: routing }),
  )
  try {
    const result = await delegate.execute(
      { task_id: session, ...selection, prompt: "Continue", description: "Resume", load_skills: [] },
      unsafeTestValue({
        sessionID: "ses_parent",
        messageID: "msg_parent",
        agent: "sisyphus",
        abort: new AbortController().signal,
      }),
    )
    expect(result).toContain("Continued answer")
    expect(promptAsync).toHaveBeenCalledWith(expect.objectContaining({ path: { id: session } }))
    expect(fetchSpy).not.toHaveBeenCalled()
  } finally {
    fetchSpy.mockRestore()
  }
})

test("a real named agent dispatches without category observation", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Classifier must not run"))
  const launch = mock(async () => ({ id: "task-explore", sessionId: "ses_explore", status: "running" }))
  const delegate = createDelegateTask(
    unsafeTestValue({
      manager: { launch },
      directory: process.cwd(),
      jevRouting: routing,
      client: {
        app: {
          agents: async () => ({
            data: [{ name: "explore", mode: "subagent", model: { providerID: "example", modelID: "high" } }],
          }),
        },
        config: { get: async () => ({ data: {} }) },
        session: { messages: async () => ({ data: [] }) },
      },
    }),
  )
  try {
    await delegate.execute(
      { subagent_type: "explore", prompt: "Inspect", description: "Explore", run_in_background: true, load_skills: [] },
      unsafeTestValue({
        sessionID: "ses_parent",
        messageID: "msg_parent",
        agent: "sisyphus",
        abort: new AbortController().signal,
      }),
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "explore", model: expect.objectContaining({ modelID: "high" }) }),
    )
  } finally {
    fetchSpy.mockRestore()
  }
})
