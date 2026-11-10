import { afterEach, describe, expect, it } from "bun:test"
import { createFakePluginContext } from "../../v2/fake-plugin-context"
import { createPluginInput } from "../../v2/create-plugin-input"
import { createSessionTracker } from "../../v2/session-tracker"
import { releaseAllPromptAsyncReservationsForTesting } from "../shared/prompt-async-gate"
import { createTodoContinuationHandler } from "./handler"
import { injectContinuation } from "./continuation-injection"
import { createSessionStateStore } from "./session-state"

const waiting = {
  id: "waiting",
  content: "Approve release",
  status: "pending",
  priority: "high",
  metadata: { waiting_on: "user" },
}
const actionable = { id: "actionable", content: "Run independent checks", status: "in_progress", priority: "high" }

function fixture(initialTodos = [waiting]) {
  const fake = createFakePluginContext()
  const ctx = createPluginInput(fake.context, { tracker: createSessionTracker(), warn: () => {} })
  let todos: Array<{
    id: string
    content: string
    status: string
    priority: string
    metadata?: { waiting_on: string }
  }> = initialTodos
  const prompts: string[] = []
  Object.assign(ctx.client.session, {
    todo: async () => ({ data: todos }),
    messages: async () => ({
      data: [
        {
          info: { role: "assistant", agent: "sisyphus", finish: "stop", time: { completed: 1 } },
          parts: [{ type: "text", text: "Ready" }],
        },
      ],
    }),
    promptAsync: async (input: { body: { parts: readonly { text: string }[] } }) => {
      prompts.push(input.body.parts.map((part) => part.text).join("\n"))
      return {}
    },
  })
  const store = createSessionStateStore()
  const handler = createTodoContinuationHandler({ ctx, sessionStateStore: store })
  const idle = () => handler({ event: { type: "session.idle", properties: { sessionID: "waiting-user" } } })
  const inject = () =>
    injectContinuation({
      ctx,
      sessionID: "waiting-user",
      sessionStateStore: store,
      resolvedInfo: { agent: "sisyphus", model: { providerID: "test", modelID: "test" } },
    })
  return {
    handler,
    idle,
    inject,
    store,
    prompts,
    update: (next: typeof todos) => {
      todos = next
    },
  }
}

afterEach(() => releaseAllPromptAsyncReservationsForTesting())

describe("user-waiting todo continuation", () => {
  it("does not schedule repeated idles or complete tasks while every unfinished task waits for the user", async () => {
    // given
    const f = fixture()
    try {
      // when
      await f.idle()
      await f.idle()
      // then
      expect(f.store.getState("waiting-user").countdownTimer).toBeUndefined()
      expect(f.store.getState("waiting-user").allTodosCompletedAt).toBeUndefined()
      expect(f.prompts).toEqual([])
    } finally {
      f.store.shutdown()
    }
  })

  it("keeps waiting after an unrelated user message and schedules after explicit marker clearing", async () => {
    // given
    const f = fixture()
    try {
      await f.idle()
      await f.handler({
        event: {
          type: "message.updated",
          properties: {
            info: { sessionID: "waiting-user", id: "user-message", role: "user" },
            parts: [{ type: "text", text: "Show current progress" }],
          },
        },
      })
      await f.idle()
      expect(f.store.getState("waiting-user").countdownTimer).toBeUndefined()
      // when
      f.update([{ ...actionable, id: waiting.id, content: waiting.content, status: "pending" }])
      await f.idle()
      // then
      expect(f.store.getState("waiting-user").countdownTimer).toBeDefined()
      await f.inject()
      expect(f.prompts).toHaveLength(1)
    } finally {
      f.store.shutdown()
    }
  })

  it("schedules independent work and excludes waiting tasks from the injected list", async () => {
    // given
    const f = fixture()
    f.update([waiting, actionable])
    try {
      // when
      await f.idle()
      // then
      expect(f.store.getState("waiting-user").countdownTimer).toBeDefined()
      await f.inject()
      expect(f.prompts).toHaveLength(1)
      expect(f.prompts[0]).toContain(actionable.content)
      expect(f.prompts[0]).not.toContain(waiting.content)
    } finally {
      f.store.shutdown()
    }
  })

  it("rechecks waiting metadata when an already scheduled continuation reaches injection", async () => {
    // given
    const f = fixture()
    f.update([actionable])
    try {
      await f.idle()
      expect(f.store.getState("waiting-user").countdownTimer).toBeDefined()
      // when
      f.update([{ ...actionable, metadata: { waiting_on: "user" } }])
      await f.inject()
      // then
      expect(f.prompts).toEqual([])
    } finally {
      f.store.shutdown()
    }
  })
})
