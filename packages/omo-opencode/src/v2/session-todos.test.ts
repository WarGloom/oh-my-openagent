import { describe, expect, it } from "bun:test"
import type { V2PluginContext, V2SessionMessage, V2StorageDomain, V2ToolAfterEvent } from "./context-types"
import { createFakePluginContext } from "./fake-plugin-context"
import { createPluginInput } from "./create-plugin-input"
import { createSessionTracker } from "./session-tracker"
import { installToolHooks } from "./tool-hooks"
import { syncAllTasksToTodos, syncTaskTodoUpdate } from "../tools/task/todo-sync"
import type { Task } from "../features/claude-tasks/types"

function storage(): V2StorageDomain {
  const entries = new Map<string, unknown>()
  return {
    get: async (key) => entries.get(key),
    set: async (key, value) => {
      entries.set(key, structuredClone(value))
    },
    remove: async (key) => {
      entries.delete(key)
    },
    scan: async () => ({ entries: [] }),
  }
}

function input(context: V2PluginContext) {
  return createPluginInput(context, { tracker: createSessionTracker(), warn: () => {} })
}

function writeEvent(todos: unknown, status: "completed" | "error" = "completed"): V2ToolAfterEvent {
  return {
    tool: "todowrite",
    sessionID: "ses_1",
    agent: "build",
    messageID: "msg_1",
    id: "call_1",
    input: { todos },
    status,
    ...(status === "completed" ? { result: { content: "Updated todos" } } : {}),
  }
}

function history(status: "completed" | "error", content: string, id = content): V2SessionMessage {
  return {
    type: "assistant",
    id: content,
    time: { created: 1 },
    agent: "build",
    model: { providerID: "test", id: "test" },
    content: [
      {
        type: "tool",
        id,
        name: "todowrite",
        time: { created: 1 },
        state:
          status === "completed"
            ? { status, input: { todos: [{ content, status: "pending" }] }, content: [] }
            : {
                status,
                input: { todos: [{ content, status: "pending" }] },
                error: { type: "Error", message: "failed" },
              },
      },
    ],
  }
}

const task: Task = {
  id: "T-1",
  subject: "Port todos",
  description: "",
  status: "pending",
  blocks: [],
  blockedBy: [],
  metadata: { priority: "high" },
}

describe("V2 session todos", () => {
  it("rebuilds the latest successful historical list in V1 shape before the plugin loaded", async () => {
    // given
    const fake = createFakePluginContext({
      sessionMessages: [history("completed", "Old"), history("completed", "Current"), history("error", "Failed")],
    })
    const ctx = input({ ...fake.context, storage: storage() })
    // when
    const response = await ctx.client.session.todo({ path: { id: "ses_1" } })
    // then
    expect(response.data).toEqual([{ content: "Current", status: "pending", priority: "medium", id: "v2-todo-1" }])
  })

  it("captures native writes before V1 after-hooks read them, isolates sessions, and survives reload", async () => {
    // given
    const fake = createFakePluginContext()
    const store = storage()
    const context = { ...fake.context, storage: store }
    const ctx = input(context)
    let observed: unknown
    const dispose = await installToolHooks(context, {
      "tool.execute.after": async () => {
        observed = (await ctx.client.session.todo({ path: { id: "ses_1" } })).data
      },
    })
    // when
    await fake.triggerToolAfter(writeEvent([{ content: "Native", status: "in_progress" }]))
    await dispose()
    const reloaded = input({ ...createFakePluginContext().context, storage: store })
    // then
    const expected = [{ content: "Native", status: "in_progress", priority: "medium", id: "v2-todo-1" }]
    expect(observed).toEqual(expected)
    expect((await reloaded.client.session.todo({ path: { id: "ses_1" } })).data).toEqual(expected)
    expect((await reloaded.client.session.todo({ path: { id: "ses_2" } })).data).toEqual([])
    expect(fake.toolHookCount()).toBe(0)
  })

  it.each(["completed", "error"] as const)(
    "handles an empty %s write without reviving historical todos",
    async (status) => {
      // given
      const messages = [history("completed", "Historical")]
      const fake = createFakePluginContext({ sessionMessages: messages })
      const context = { ...fake.context, storage: storage() }
      const ctx = input(context)
      const dispose = await installToolHooks(context, {})
      // when
      try {
        if (status === "completed") messages.push(history("completed", "Native", "call_1"))
        await fake.triggerToolAfter(writeEvent([], status))
        const result = await ctx.client.session.todo({ path: { id: "ses_1" } })
        // then
        expect(result.data).toEqual(
          status === "completed"
            ? []
            : [{ content: "Historical", status: "pending", priority: "medium", id: "v2-todo-1" }],
        )
      } finally {
        await dispose()
      }
    },
  )

  it("keeps task todo writes, updates, bulk sync, and reload reads consistent", async () => {
    // given
    const fake = createFakePluginContext()
    const store = storage()
    const ctx = input({ ...fake.context, storage: store })
    await syncTaskTodoUpdate(ctx, task, "ses_1")
    await syncTaskTodoUpdate(ctx, { ...task, subject: "Port current todos", status: "in_progress" }, "ses_1")
    // when
    await syncAllTasksToTodos(ctx, [{ ...task, subject: "Port current todos", status: "completed" }], "ses_1")
    const reloaded = input({ ...createFakePluginContext().context, storage: store })
    // then
    expect((await reloaded.client.session.todo({ path: { id: "ses_1" } })).data).toEqual([
      { id: "T-1", content: "Port current todos", status: "completed", priority: "high" },
    ])
  })

  it("prefers a newer historical native write over an older stored snapshot after reload", async () => {
    // given
    const store = storage()
    const ctx = input({
      ...createFakePluginContext({ sessionMessages: [history("completed", "Old")] }).context,
      storage: store,
    })
    await ctx.client.session.todo({ path: { id: "ses_1" } })
    const reloaded = input({
      ...createFakePluginContext({ sessionMessages: [history("completed", "Old"), history("completed", "New")] })
        .context,
      storage: store,
    })
    // when
    const result = await reloaded.client.session.todo({ path: { id: "ses_1" } })
    // then
    expect(result.data).toEqual([{ content: "New", status: "pending", priority: "medium", id: "v2-todo-1" }])
  })

  it("keeps task writes over the historical native list they replace", async () => {
    // given
    const store = storage()
    const context = {
      ...createFakePluginContext({ sessionMessages: [history("completed", "Manual")] }).context,
      storage: store,
    }
    const ctx = input(context)
    await syncTaskTodoUpdate(ctx, task, "ses_1")
    // when
    const reloaded = input({ ...context })
    const result = await reloaded.client.session.todo({ path: { id: "ses_1" } })
    // then
    expect(result.data).toEqual([
      { id: "v2-todo-1", content: "Manual", status: "pending", priority: "medium" },
      { id: "T-1", content: "Port todos", status: "pending", priority: "high" },
    ])
  })
})
