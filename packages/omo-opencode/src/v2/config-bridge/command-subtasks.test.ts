import { expect, it } from "bun:test"
import { createFakePluginContext } from "../fake-plugin-context"
import { installConfigBridge } from "./install-config-bridge"
import { bindNativeCommandJobs, type CommandJobLaunch } from "./command-subtasks"

it("routes subtask commands through the native FIFO manager without switching or prompting the parent", async () => {
  // given
  const fake = createFakePluginContext({
    agents: [
      {
        id: "worker",
        name: "worker",
        mode: "subagent",
        hidden: false,
        permissions: [],
        model: { providerID: "agent", id: "default" },
      },
    ],
    sessionAgent: "parent",
    sessionInfo: { model: { providerID: "parent-provider", id: "parent-model" } },
  })
  const launches: CommandJobLaunch[] = []
  bindNativeCommandJobs(fake.context, {
    launch: async (input) => {
      launches.push(input)
      return { status: "pending" }
    },
  })
  const metadata = { omoCommandParts: [{ type: "text", text: "marker", synthetic: true }], external: "retained" }
  const prompt = {
    text: "review",
    files: [
      {
        uri: "file:///work/a.md",
        name: "a.md",
        source: { type: "uri" as const, uri: "file:///work/a.md" },
        description: "attachment",
        mention: { start: 0, end: 1, text: "a" },
      },
    ],
    agents: [{ name: "helper" }],
    skills: [{ id: "skill_1", mention: { start: 0, end: 1, text: "s" } }],
  }
  const dispose = await installConfigBridge(
    fake.context,
    async (config) => {
      config.command = {
        review: { template: "Review: $ARGUMENTS", agent: "worker", model: "chosen/model#high", subtask: true },
      }
    },
    { warn: () => {} },
  )
  try {
    // when
    await fake.builtCommands().get("review")?.execute({
      invocationID: "host_invocation_1",
      agent: "authentic-parent",
      sessionID: "parent_session",
      prompt,
      metadata,
      delivery: "queue",
    })
    // then
    expect(fake.sessionCalls).toEqual([])
    expect(launches).toEqual([
      {
        agent: "worker",
        model: { providerID: "chosen", modelID: "model", variant: "high" },
        description: "review",
        prompt: "Review: review",
        parentSessionId: "parent_session",
        parentMessageId: "host_invocation_1",
        parentAgent: "authentic-parent",
        nativePrompt: { ...prompt, text: "Review: review" },
        nativeMetadata: metadata,
        nativeInvocation: {
          kind: "command",
          invocationID: "host_invocation_1",
          command: "review",
          agent: "authentic-parent",
        },
        nativeCompletion: "parent",
        nativeMode: "background",
      },
    ])
  } finally {
    await dispose()
  }
})

it("rejects unbound subtask dispatch instead of silently executing inline", async () => {
  // given
  const fake = createFakePluginContext()
  const dispose = await installConfigBridge(
    fake.context,
    async (config) => {
      config.command = { task: { template: "$ARGUMENTS", subtask: true } }
    },
    { warn: () => {} },
  )
  try {
    // when / then
    await expect(
      fake
        .builtCommands()
        .get("task")
        ?.execute({
          invocationID: "host_1",
          agent: "parent",
          sessionID: "parent",
          prompt: { text: "work" },
          delivery: "steer",
        }),
    ).rejects.toThrow("Native command background manager has not been connected")
    expect(fake.sessionCalls).toEqual([])
  } finally {
    await dispose()
  }
})

it("keeps the authentic primary parent agent for a subtask command without an agent override", async () => {
  // given
  const fake = createFakePluginContext({
    agents: [{ id: "primary", name: "primary", mode: "primary", hidden: false, permissions: [] }],
    sessionAgent: "primary",
    sessionInfo: { model: { providerID: "qa", id: "gpt-fake" } },
  })
  const launches: CommandJobLaunch[] = []
  bindNativeCommandJobs(fake.context, {
    launch: async (input) => {
      launches.push(input)
    },
  })
  const dispose = await installConfigBridge(
    fake.context,
    async (config) => {
      config.command = { "qa-csub": { template: "QA_SUB_MARK $ARGUMENTS", subtask: true } }
    },
    { warn: () => {} },
  )
  try {
    // when
    await fake
      .builtCommands()
      .get("qa-csub")
      ?.execute({
        invocationID: "command_primary_1",
        agent: "primary",
        sessionID: "parent",
        prompt: { text: "first" },
        delivery: "queue",
      })
    // then
    expect(launches.map(({ agent, model, nativeInvocation }) => ({ agent, model, nativeInvocation }))).toEqual([
      {
        agent: "primary",
        model: { providerID: "qa", modelID: "gpt-fake" },
        nativeInvocation: { kind: "command", agent: "primary", invocationID: "command_primary_1", command: "qa-csub" },
      },
    ])
    expect(fake.sessionCalls).toEqual([])
  } finally {
    await dispose()
  }
})
