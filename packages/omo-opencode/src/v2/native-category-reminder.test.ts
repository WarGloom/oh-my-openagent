import { expect, it } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { clearSessionAgent, setSessionAgent } from "../features/claude-code-session-state"
import { createCategorySkillReminderHook } from "../hooks/category-skill-reminder/hook"
import { createMessagesTransformHandler } from "../plugin/messages-transform"
import { createFakePluginContext } from "./fake-plugin-context"
import { createPluginInput } from "./create-plugin-input"
import { createSessionTracker } from "./session-tracker"
import { installSessionHooks } from "./session-hooks"
import { installToolHooks } from "./tool-hooks"
import type { V2SessionMessage } from "./context-types"

it("#given three eligible tools #when V2 builds context #then one durable synthetic reminder replaces bridge injection", async () => {
  // given
  const fake = createFakePluginContext({
    sessionMessages: [{ type: "user", id: "msg_1", text: "work", time: { created: 1 } }],
  })
  const input = createPluginInput(fake.context, { tracker: createSessionTracker(), warn: () => {} })
  const hook = createCategorySkillReminderHook(input)
  const transform = createMessagesTransformHandler({ hooks: { categorySkillReminder: hook } })
  const hooks = {
    "experimental.chat.messages.transform": transform,
    "tool.execute.after": hook["tool.execute.after"],
  } as Hooks
  const stopTools = await installToolHooks(fake.context, hooks)
  const stopSession = await installSessionHooks(fake.context, hooks, { warn: () => {} })
  setSessionAgent("ses_1", "sisyphus")
  try {
    // when
    for (const id of ["one", "two", "three"]) {
      await fake.triggerToolAfter({
        tool: "read",
        sessionID: "ses_1",
        agent: "sisyphus",
        messageID: "msg_1",
        id,
        input: {},
        status: "completed",
        result: {},
      })
    }
    const makeEvent = () => ({
      sessionID: "ses_1",
      agent: "sisyphus",
      model: { providerID: "openai", id: "gpt-test" },
      system: [],
      messages: [{ id: "msg_1", role: "user", content: [{ type: "text", text: "work" }] }],
      options: {},
    })
    const first = await fake.triggerContext(makeEvent())
    await fake.triggerContext(makeEvent())
    // then
    const calls = fake.sessionCalls.filter((call) => call.kind === "synthetic")
    expect(first.messages).toHaveLength(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toMatchObject({ sessionID: "ses_1", delivery: "steer", resume: false })
    expect(calls[0]?.input.id).toStartWith("msg_")
  } finally {
    clearSessionAgent("ses_1")
    await stopSession()
    await stopTools()
  }
})

it("#given only a synthetic user turn #when context is built #then the reminder waits for a real user", async () => {
  // given
  const fake = createFakePluginContext()
  let history: V2SessionMessage[] = [{ type: "synthetic", id: "msg_internal", text: "internal", time: { created: 1 } }]
  const context = { ...fake.context, session: { ...fake.context.session, context: async () => history } }
  const input = createPluginInput(context, { tracker: createSessionTracker(), warn: () => {} })
  const hook = createCategorySkillReminderHook(input)
  const transform = createMessagesTransformHandler({ hooks: { categorySkillReminder: hook } })
  const cleanup = await installSessionHooks(context, { "experimental.chat.messages.transform": transform } as Hooks, {
    warn: () => {},
  })
  for (const id of ["one", "two", "three"]) {
    await hook["tool.execute.after"](
      { tool: "read", sessionID: "ses_1", callID: id, agent: "sisyphus" },
      { title: "", output: "", metadata: {} },
    )
  }
  const event = (id: string, text: string) => ({
    sessionID: "ses_1",
    agent: "sisyphus",
    model: { providerID: "openai", id: "gpt-test" },
    system: [],
    messages: [{ id, role: "user", content: [{ type: "text", text }] }],
    options: {},
  })
  try {
    // when
    await fake.triggerContext(event("msg_internal", "internal"))
    expect(fake.sessionCalls.filter((call) => call.kind === "synthetic")).toHaveLength(0)
    history = [{ type: "user", id: "msg_marked", text: "internal", time: { created: 2 } }]
    await fake.triggerContext(event("msg_marked", "internal <!-- OMO_INTERNAL_INITIATOR -->"))
    expect(fake.sessionCalls.filter((call) => call.kind === "synthetic")).toHaveLength(0)
    history = [{ type: "user", id: "msg_real", text: "real", time: { created: 2 } }]
    await fake.triggerContext(event("msg_real", "real"))
    // then
    expect(fake.sessionCalls.filter((call) => call.kind === "synthetic")).toHaveLength(1)
  } finally {
    await cleanup()
  }
})
