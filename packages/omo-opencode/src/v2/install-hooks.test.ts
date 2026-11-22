import { describe, expect, it, mock, spyOn } from "bun:test"
import { tool } from "@opencode-ai/plugin/tool"
import type { Hooks } from "@opencode-ai/plugin"
import type { V2PluginContext, V2Registration, V2ToolEditor, V2ToolInfo } from "./context-types"
import { createFakePluginContext } from "./fake-plugin-context"
import { installHooks } from "./install-hooks"
import { bindReplyCheck } from "./native-reply-check"
import { ReplyCheckConfigSchema } from "../config/schema/reply-check"

function createFakeContext() {
  const added: V2ToolInfo[] = []
  const disposals: Array<ReturnType<typeof mock<() => Promise<void>>>> = []
  const transform = mock(async (callback: (editor: V2ToolEditor) => void): Promise<V2Registration> => {
    callback({ add: (info) => void added.push(info), list: () => [], update: () => {} })
    const dispose = mock(async () => {})
    disposals.push(dispose)
    return { dispose }
  })
  const fake = createFakePluginContext()
  const context: V2PluginContext = { ...fake.context, tool: { ...fake.context.tool, transform } }
  return { context, added, transform, disposals }
}

const echo = tool({
  description: "Echo",
  args: { text: tool.schema.string() },
  execute: async (args) => args.text,
})

describe("installHooks", () => {
  it("queues one warning for the final reply, without waking or rewriting it", async () => {
    const fake = createFakePluginContext()
    const hooks: Hooks = {}
    const rule = { name: "Reference format", citation: "Owner reply policy", rule_text: "Format hashes as code." }
    const progress = { ...rule, name: "Progress only", question: "Does the reply only report progress?" }
    const decision = { ...rule, name: "Options", question: "Does the reply ask for a decision without its options?" }
    bindReplyCheck(
      hooks,
      ReplyCheckConfigSchema.parse({
        patterns: [{ ...rule, pattern: "\\b[0-9a-f]{7,40}\\b", ignore: ["`+[^`]+`+"] }],
        phrases: [{ ...rule, name: "English terms", phrases: ["translated.term"] }],
        jev: { progress_only: progress, missing_decision_options: decision },
      }),
    )
    const delivered = Promise.withResolvers<void>()
    const context: V2PluginContext = {
      ...fake.context,
      session: {
        ...fake.context.session,
        synthetic: async (input) => {
          await fake.context.session.synthetic(input)
          delivered.resolve()
        },
      },
    }
    const dispose = await installHooks(context, hooks, { warn: () => {} })
    const previousKey = process.env.TYPESAFE_API_KEY
    process.env.TYPESAFE_API_KEY = "fixture-key"
    const request = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        answers: { progress_only: { type: "noul", noul: 0.2 }, missing_decision_options: { type: "noul", noul: 0.8 } },
      }),
    )
    try {
      const reply = "Use `abcdef0`, https://example.com/abcdef1, abcdef2, and translated.term."
      const history = fake.sessionHistory("ses_reply")
      history.push(
        {
          type: "assistant",
          id: "msg_reply",
          agent: "sisyphus",
          model: { providerID: "test", id: "test" },
          finish: "stop",
          time: { created: 1, completed: 2 },
          content: [{ type: "text", text: reply }],
        },
        { type: "idle", id: "msg_finished", outcome: "succeeded", time: { created: 3 } },
      )
      fake.emit({ type: "session.execution.succeeded", id: "evt_stale", data: { sessionID: "ses_reply" } })
      fake.emit({ type: "session.execution.succeeded", id: "evt_finished", data: { sessionID: "ses_reply" } })
      await delivered.promise
      const notices = fake.sessionCalls.flatMap((call) => (call.kind === "synthetic" ? [call.input] : []))
      expect(notices).toHaveLength(1)
      expect(notices[0]).toMatchObject({ sessionID: "ses_reply", delivery: "steer", resume: false })
      expect(notices[0]?.text).toContain('"matched_text":"abcdef2"')
      expect(notices[0]?.text).toContain('"matched_text":"translated.term"')
      expect(notices[0]?.text).not.toContain('"matched_text":"abcdef0"')
      expect(notices[0]?.text).not.toContain('"matched_text":"abcdef1"')
      expect(notices[0]?.text).toContain('"rule":"Options"')
      expect(notices[0]?.text).not.toContain('"rule":"Progress only"')
      expect(request).toHaveBeenCalledTimes(1)
      const payload = request.mock.calls[0]?.[1]?.body
      expect(typeof payload === "string" ? JSON.parse(payload).state : undefined).toEqual({ reply })
      expect(history[0]).toMatchObject({ content: [{ type: "text", text: reply }] })
    } finally {
      request.mockRestore()
      if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY
      else process.env.TYPESAFE_API_KEY = previousKey
      await dispose()
    }
  })

  describe("#given V1 hooks that define tools", () => {
    it("#when installed #then every tool is added through one 2.x tool transform", async () => {
      // given
      const { context, added, transform } = createFakeContext()
      const hooks: Hooks = { tool: { echo, shout: echo } }

      // when
      await installHooks(context, hooks, { warn: () => {} })

      // then
      expect(transform).toHaveBeenCalledTimes(2)
      expect(added.map((info) => info.name)).toEqual(["session_handoff", "echo", "shout"])
      expect(added[1]?.options).toEqual({ codemode: false })
    })

    it("#when the returned disposer runs #then the tool registration is disposed once", async () => {
      // given
      const { context, disposals } = createFakeContext()
      const uninstall = await installHooks(context, { tool: { echo } }, { warn: () => {} })

      // when
      await uninstall()
      await uninstall()

      // then
      expect(disposals.map((dispose) => dispose.mock.calls.length)).toEqual([1, 1])
    })
  })

  describe("#given one tool whose input schema cannot be converted", () => {
    it("#when installed #then only that tool is skipped, named in a warning, and the others register", async () => {
      // given
      const { context, added } = createFakeContext()
      const broken = { description: "broken", args: { oops: 5 }, execute: async () => "x" } as unknown as typeof echo
      const warn = mock((_message: string) => {})

      // when
      await installHooks(context, { tool: { before: echo, broken, after: echo } }, { warn })

      // then
      expect(added.map((info) => info.name)).toEqual(["session_handoff", "before", "after"])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toContain('"broken"')
    })
  })

  describe("#given a V1 config hook that defines agents", () => {
    it("#when installed #then the hook runs once and its agents exist on the host until disposed", async () => {
      // given
      const fake = createFakePluginContext()
      const configHook = mock(async (config: Record<string, unknown>) => {
        Object.assign(config, { agent: { Sisyphus: { prompt: "You orchestrate." } } })
      })
      const hooks = { config: configHook } as unknown as Hooks

      // when
      const uninstall = await installHooks(fake.context, hooks, { warn: () => {} })

      // then
      expect(configHook).toHaveBeenCalledTimes(1)
      expect(fake.builtAgents().get("Sisyphus")?.system).toBe("You orchestrate.")

      // when
      await uninstall()

      // then
      expect(fake.activeSubscribers()).toBe(0)
    })
  })

  describe("#given V1 tool execute hooks", () => {
    it("#when installed #then they run around 2.x tool calls until disposed", async () => {
      // given
      const fake = createFakePluginContext()
      const seen: string[] = []
      const hooks = {
        "tool.execute.before": async (input: { tool: string }) => void seen.push(`before:${input.tool}`),
        "tool.execute.after": async (input: { tool: string }) => void seen.push(`after:${input.tool}`),
      } as unknown as Hooks
      const uninstall = await installHooks(fake.context, hooks, { warn: () => {} })

      // when
      await fake.triggerToolBefore({ tool: "shell", sessionID: "s", agent: "a", messageID: "m", id: "c", input: {} })
      await fake.triggerToolAfter({
        tool: "shell",
        sessionID: "s",
        agent: "a",
        messageID: "m",
        id: "c",
        input: {},
        status: "completed",
        result: { content: [] },
      })
      await uninstall()

      // then
      expect(seen).toEqual(["before:bash", "after:bash"])
      expect(fake.toolHookCount()).toBe(0)
    })
  })

  describe("#given V1 hooks without tools", () => {
    it("#when installed #then only the native handoff tool is registered", async () => {
      // given
      const { context, added, transform } = createFakeContext()

      // when
      await installHooks(context, {}, { warn: () => {} })

      // then
      expect(transform).toHaveBeenCalledTimes(1)
      expect(added.map((info) => info.name)).toEqual(["session_handoff"])
    })
  })
})
