import { describe, expect, it, mock } from "bun:test"
import { createFakePluginContext, type FakeContextOptions } from "../fake-plugin-context"
import { createSessionTracker } from "../session-tracker"
import { createSessionNamespace } from "./session-namespace"
import { createInternalAgentTextPart, withInternalNoReplyMarker } from "@oh-my-opencode/utils/internal-initiator-marker"

const opus = { providerID: "anthropic", id: "claude-opus" }

function setup(options: FakeContextOptions = {}) {
  const fake = createFakePluginContext({ sessionAgent: "Sisyphus", sessionInfo: { model: opus }, ...options })
  const tracker = createSessionTracker()
  const warn = mock((_message: string) => {})
  const session = createSessionNamespace(fake.context, { tracker, warn })
  return { fake, tracker, warn, session }
}

describe("createSessionNamespace", () => {
  describe("#given promptAsync", () => {
    it.each([
      { current: "default", target: undefined, switches: false },
      { current: undefined, target: "default", switches: false },
      { current: "checkpoint", target: "high", switches: true },
    ])("compares current $current and requested $target variants", async ({ current, target, switches }) => {
      const { fake, session } = setup({
        sessionInfo: { model: { ...opus, ...(current === undefined ? {} : { variant: current }) } },
      })
      const result = await session.promptAsync({
        path: { id: "ses_1" },
        body: {
          model: { providerID: opus.providerID, modelID: opus.id },
          ...(target === undefined ? {} : { variant: target }),
          parts: [{ type: "text", text: "go" }],
        },
      })
      expect(result.error).toBeUndefined()
      expect(fake.sessionCalls.filter((call) => call.kind === "switchModel")).toHaveLength(switches ? 1 : 0)
    })

    it("preserves the current agent's supported configured variant without switching", async () => {
      const configured = { providerID: "openai", id: "sol", variant: "xhigh" }
      const { fake, session } = setup({
        sessionAgent: "worker",
        sessionInfo: { model: configured },
        agents: [{ id: "worker", name: "worker", model: configured, mode: "subagent", hidden: false, permissions: [] }],
        models: [
          {
            id: "sol",
            modelID: "sol",
            providerID: "openai",
            name: "sol",
            status: "active",
            enabled: true,
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            variants: [{ id: "xhigh" }],
            limit: { context: 100, output: 10 },
          },
        ],
      })
      await session.promptAsync({
        path: { id: "ses_1" },
        body: { model: { providerID: "openai", modelID: "sol" }, parts: [{ type: "text", text: "go" }] },
      })
      expect(fake.sessionCalls.map((call) => call.kind)).toEqual(["prompt"])
    })

    it("uses the requested agent's variant only when its model matches and the host offers it", async () => {
      const configured = { providerID: "openai", id: "sol", variant: "xhigh" }
      for (const [target, variants, expected] of [
        ["sol", [{ id: "xhigh" }], { providerID: "openai", id: "sol", variant: "xhigh" }],
        ["other", [{ id: "xhigh" }], { providerID: "openai", id: "other" }],
        ["sol", [], { providerID: "openai", id: "sol" }],
      ] as const) {
        const { fake, session } = setup({
          agents: [
            { id: "worker", name: "worker", model: configured, mode: "subagent", hidden: false, permissions: [] },
          ],
          models: [
            {
              id: "sol",
              modelID: "sol",
              providerID: "openai",
              name: "sol",
              status: "active",
              enabled: true,
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              variants,
              limit: { context: 100, output: 10 },
            },
          ],
        })
        await session.promptAsync({
          path: { id: "ses_1" },
          body: {
            agent: "worker",
            model: { providerID: "openai", modelID: target },
            parts: [{ type: "text", text: "go" }],
          },
        })
        expect(fake.sessionCalls).toContainEqual({ kind: "switchModel", sessionID: "ses_1", model: expected })
      }
    })
    it("#when called with text #then it queues a prompt and starts a turn", async () => {
      // given
      const { fake, session } = setup()

      // when
      await session.promptAsync({
        path: { id: "ses_1" },
        body: {
          parts: [
            { type: "text", text: "go" },
            { type: "text", text: "now" },
          ],
        },
      })

      // then
      expect(fake.sessionCalls).toEqual([
        { kind: "prompt", input: { sessionID: "ses_1", text: "go\n\nnow", delivery: "queue", resume: true } },
      ])
    })

    it("#when noReply is set #then the message is queued without starting a turn", async () => {
      // given
      const { fake, session } = setup()

      // when
      await session.promptAsync({
        path: { id: "ses_1" },
        body: { noReply: true, parts: [{ type: "text", text: "context" }] },
      })

      // then
      expect(fake.sessionCalls).toEqual([
        { kind: "prompt", input: { sessionID: "ses_1", text: "context", delivery: "queue", resume: false } },
      ])
    })

    it.each([
      [{ type: "text", text: "context", synthetic: true }, false, "synthetic"],
      [createInternalAgentTextPart("terminal notice"), false, "prompt"],
      [withInternalNoReplyMarker(createInternalAgentTextPart("intermediate notice")), true, "prompt"],
    ] as const)(
      "#when internal context %j has noReply=%s #then native steering preserves reply intent",
      async (part, noReply, kind) => {
        // given
        const { fake, session } = setup()

        // when
        await session.promptAsync({
          path: { id: "ses_1" },
          body: { noReply, parts: [part] },
        })

        // then
        expect(fake.sessionCalls).toEqual([
          { kind, input: { sessionID: "ses_1", text: part.text, delivery: "steer", resume: !noReply } },
        ])
      },
    )

    it("#when the agent or model differs from the session's #then it switches first, keeping the variant", async () => {
      // given
      const { fake, session } = setup()

      // when
      await session.promptAsync({
        path: { id: "ses_1" },
        body: {
          agent: "Atlas - Plan Executor",
          model: { providerID: "openai", modelID: "gpt-x" },
          variant: "high",
          parts: [{ type: "text", text: "go" }],
        },
      })

      // then
      expect(fake.sessionCalls).toEqual([
        { kind: "switchAgent", sessionID: "ses_1", agent: "Atlas - Plan Executor" },
        { kind: "switchModel", sessionID: "ses_1", model: { providerID: "openai", id: "gpt-x", variant: "high" } },
        { kind: "prompt", input: { sessionID: "ses_1", text: "go", delivery: "queue", resume: true } },
      ])
    })

    it("#when the agent and model already match #then no switch is made", async () => {
      // given
      const { fake, session } = setup()

      // when
      await session.promptAsync({
        path: { id: "ses_1" },
        body: {
          agent: "Sisyphus",
          model: { providerID: "anthropic", modelID: "claude-opus" },
          parts: [{ type: "text", text: "go" }],
        },
      })

      // then
      expect(fake.sessionCalls.map((call) => call.kind)).toEqual(["prompt"])
    })

    it("#when the body has files and system instructions #then it carries both without unsupported-part warnings", async () => {
      // given
      const { fake, session, warn } = setup()
      const body = {
        tools: { task: false },
        system: "be brief",
        parts: [
          { type: "text", text: "go" },
          { type: "file", url: "file:///a.png", mime: "image/png" },
        ],
      }

      // when
      await session.promptAsync({ path: { id: "ses_1" }, body })
      await session.promptAsync({ path: { id: "ses_1" }, body })

      // then
      expect(fake.sessionCalls.filter((call) => call.kind === "prompt")).toHaveLength(2)
      const warnings = warn.mock.calls.map((call) => call[0])
      expect(warnings.filter((message) => message.includes("tools"))).toHaveLength(0)
      expect(warnings.filter((message) => message.includes("system"))).toHaveLength(0)
      expect(warnings.filter((message) => message.includes("file"))).toHaveLength(0)
    })

    it("#when the host rejects the prompt #then the result carries an error", async () => {
      // given
      const { fake } = setup()
      const context = {
        ...fake.context,
        session: { ...fake.context.session, prompt: async () => Promise.reject(new Error("session busy")) },
      }
      const broken = createSessionNamespace(context, { tracker: createSessionTracker(), warn: () => {} })

      // when
      const result = await broken.promptAsync({
        path: { id: "ses_1" },
        body: { parts: [{ type: "text", text: "go" }] },
      })

      // then
      expect(result.error).toMatchObject({ data: { message: "session busy" } })
    })
  })
})
