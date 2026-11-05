import { describe, expect, it, mock } from "bun:test"
import type { V2SessionMessage } from "../context-types"
import { createFakePluginContext, type FakeContextOptions } from "../fake-plugin-context"
import { createSessionTracker } from "../session-tracker"
import { createSessionNamespace } from "./session-namespace"
import { createClientFacade } from "./create-client-facade"
import { recoverUnarchivedTask } from "../../tools/delegate-task/unarchived-session-recovery"

const opus = { providerID: "anthropic", id: "claude-opus" }

function setup(options: FakeContextOptions = {}) {
  const fake = createFakePluginContext({ sessionAgent: "Sisyphus", sessionInfo: { model: opus }, ...options })
  const tracker = createSessionTracker()
  const warn = mock((_message: string) => {})
  const session = createSessionNamespace(fake.context, { tracker, warn })
  return { fake, tracker, warn, session }
}

const log: V2SessionMessage[] = [
  { type: "user", id: "msg_1", text: "hello", time: { created: 1 } },
  {
    type: "assistant",
    id: "msg_2",
    agent: "Sisyphus",
    model: opus,
    content: [{ type: "text", text: "hi" }],
    finish: "stop",
    time: { created: 2, completed: 3 },
  },
  { type: "user", id: "msg_3", text: "again", time: { created: 4 } },
]

describe("createSessionNamespace", () => {
  it("#given paged V2 sessions #when list is called with filters and a limit #then it maps and collects the requested sessions", async () => {
    // given
    const { fake } = setup({ directory: "/work/app", sessionInfo: { parentID: "parent" } })
    const first = await fake.context.session.get({ sessionID: "ses_1" })
    const second = await fake.context.session.get({ sessionID: "ses_2" })
    const list = mock(async (input?: Parameters<typeof fake.context.session.list>[0]) => input?.cursor
      ? { data: [second], cursor: {} }
      : { data: [first], cursor: { next: "page-2" } })
    const context = { ...fake.context, session: { ...fake.context.session, list } }
    const session = createSessionNamespace(context, { tracker: createSessionTracker(), warn: () => {} })

    // when
    const result = await session.list({ query: { directory: "/work/app", parentID: "parent", limit: 2 } })

    // then
    expect(result.data).toMatchObject([
      { id: "ses_1", parentID: "parent", directory: "/work/app" },
      { id: "ses_2", parentID: "parent", directory: "/work/app" },
    ])
    expect(list.mock.calls).toEqual([
      [{ directory: "/work/app", parentID: "parent", limit: 2 }],
      [{ directory: "/work/app", parentID: "parent", limit: 1, cursor: "page-2" }],
    ])
  })

  describe("#given messages and message", () => {
    it("recovers the model variant from a translated V2 session", async () => {
      const fake = createFakePluginContext({
        sessionAgent: "worker",
        sessionInfo: { model: { providerID: "openai", id: "sol", variant: "xhigh" } },
        sessionMessages: [{ type: "user", id: "msg_1", text: "work", time: { created: 1 } }],
      })
      const client = createClientFacade(fake.context, { tracker: createSessionTracker(), warn: () => {} })
      const task = await recoverUnarchivedTask(client, "ses_1", { sessionID: "parent", messageID: "msg_parent" }, undefined)
      expect(task.model).toEqual({ providerID: "openai", modelID: "sol", variant: "xhigh" })
    })
    it("#when messages is called #then the 2.x log arrives as 1.x messages in a data envelope", async () => {
      // given
      const { session } = setup({ sessionMessages: log })

      // when
      const result = await session.messages({ path: { id: "ses_1" } })

      // then
      expect(result.data?.map((message) => `${message.info.role}:${message.info.id}`)).toEqual([
        "user:msg_1",
        "assistant:msg_2",
        "user:msg_3",
      ])
      expect(result.data?.[0]?.info).toMatchObject({ agent: "Sisyphus", model: { providerID: "anthropic", modelID: "claude-opus" } })
    })

    it("#when messages is called with a limit #then only the most recent messages are returned", async () => {
      // given
      const { session } = setup({ sessionMessages: log })

      // when
      const result = await session.messages({ path: { id: "ses_1" }, query: { limit: 2 } })

      // then
      expect(result.data?.map((message) => message.info.id)).toEqual(["msg_2", "msg_3"])
    })

    it("#when message is called #then it returns that one message, or a not-found error", async () => {
      // given
      const { session } = setup({ sessionMessages: log })

      // when
      const found = await session.message({ path: { id: "ses_1", messageID: "msg_2" } })
      const missing = await session.message({ path: { id: "ses_1", messageID: "msg_9" } })

      // then
      expect(found.data?.info.id).toBe("msg_2")
      expect(missing.error).toMatchObject({ name: "NotFoundError" })
    })

    it("#when the host rejects the read #then the result carries an error instead of throwing", async () => {
      // given
      const { fake, session } = setup()
      const context = { ...fake.context, session: { ...fake.context.session, context: async () => Promise.reject(new Error("no such session")) } }
      const broken = createSessionNamespace(context, { tracker: createSessionTracker(), warn: () => {} })

      // when
      const result = await broken.messages({ path: { id: "ses_missing" } })

      // then
      expect(result.data).toBeUndefined()
      expect(result.error).toMatchObject({ name: "UnknownError", data: { message: "no such session" } })
      expect(session).toBeDefined()
    })
  })

  describe("#given get and create", () => {
    it("#when get is called #then the session is in the 1.x shape with its directory and parent", async () => {
      // given
      const { session } = setup({ directory: "/work/app", sessionInfo: { model: opus, parentID: "ses_parent", title: "Child" } })

      // when
      const result = await session.get({ path: { id: "ses_1" } })

      // then
      expect(result.data).toMatchObject({
        id: "ses_1",
        parentID: "ses_parent",
        title: "Child",
        directory: "/work/app",
        projectID: "proj_1",
        time: { created: 1_000, updated: 2_000 },
      })
    })

    it("#when create is called with a 1.x model #then the host creates a child session with a 2.x model", async () => {
      // given
      const { fake, session } = setup()

      // when
      const result = await session.create({
        body: { parentID: "ses_parent", title: "Explore auth", model: { providerID: "openai", modelID: "gpt-x", variant: "high" } },
        query: { directory: "/work/app" },
      })

      // then
      expect(result.data?.id).toStartWith("ses_")
      expect(fake.sessionCalls).toContainEqual({
        kind: "create",
        input: { parentID: "ses_parent", title: "Explore auth", model: { providerID: "openai", id: "gpt-x", variant: "high" } },
      })
    })

    it("#when create carries 1.x permission rules #then the host session gets the equivalent 2.x rules", async () => {
      // given
      const { fake, session } = setup()

      // when
      await session.create({
        body: {
          title: "t",
          permission: [
            { permission: "question", action: "deny", pattern: "*" },
            { permission: "bash", action: "ask", pattern: "rm *" },
          ],
        },
      })

      // then
      expect(fake.sessionCalls).toContainEqual({
        kind: "create",
        input: {
          parentID: null,
          title: "t",
          permissions: [
            { action: "question", resource: "*", effect: "deny" },
            { action: "shell", resource: "rm *", effect: "ask" },
          ],
        },
      })
    })

    it("#when create is called with a model that already uses 2.x keys #then it is passed through", async () => {
      // given
      const { fake, session } = setup()

      // when
      await session.create({ body: { title: "t", model: { providerID: "openai", id: "gpt-x" } } })

      // then
      expect(fake.sessionCalls).toContainEqual({
        kind: "create",
        input: { parentID: null, title: "t", model: { providerID: "openai", id: "gpt-x" } },
      })
    })
  })

  describe("#given delete, abort and summarize", () => {
    it("#when called #then they map to remove, interrupt and compact", async () => {
      // given
      const { fake, session } = setup()

      // when
      await session.delete({ path: { id: "ses_1" } })
      await session.abort({ path: { id: "ses_2" } })
      await session.summarize({ path: { id: "ses_3" }, body: { providerID: "anthropic", modelID: "claude-opus" } })

      // then
      expect(fake.sessionCalls).toEqual([
        { kind: "remove", sessionID: "ses_1" },
        { kind: "interrupt", sessionID: "ses_2" },
        { kind: "compact", sessionID: "ses_3" },
      ])
    })
  })

  describe("#given status and todo", () => {
    it("#when status is called #then it lists the sessions the tracker sees as busy", async () => {
      // given
      const { tracker, session } = setup()
      tracker.observe({ type: "session.execution.started", data: { sessionID: "ses_1" } })

      // when
      const result = await session.status()

      // then
      expect(result.data).toEqual({ ses_1: { type: "busy" } })
    })

    it("#when todo is called without prior writes #then it is empty without a warning", async () => {
      // given
      const { session, warn } = setup()

      // when
      const first = await session.todo({ path: { id: "ses_1" } })
      await session.todo({ path: { id: "ses_1" } })

      // then
      expect(first.data).toEqual([])
      expect(warn.mock.calls.filter((call) => call[0].includes("todo"))).toHaveLength(0)
    })
  })
})
