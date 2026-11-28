import { expect, it, test } from "bun:test"
import { mock } from "node:test"
import type { Hooks } from "@opencode-ai/plugin"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createRuntimeState, transitionRuntimeState } from "@oh-my-opencode/team-core/team-state-store/store"
import { sendMessage } from "@oh-my-opencode/team-core/team-mailbox/send"
import type { TeamSpec } from "@oh-my-opencode/team-core/types"
import { TeamModeConfigSchema } from "../config/schema/team-mode"
import { clearTeamSessionRegistry, registerTeamSession } from "../features/team-mode/team-session-registry"
import { createTeamMailboxInjector } from "../hooks/team-mailbox-injector/hook"
import { createMessagesTransformHandler } from "../plugin/messages-transform"
import { createFakePluginContext } from "./fake-plugin-context"
import { deliverNativeTeamMailbox, stopNativeTeamMailbox } from "./native-team-mailbox"
import { installSessionHooks } from "./session-hooks"

it("#given an unread team message #when V2 builds context #then it admits the message once without bridge injection", async () => {
  // given
  const baseDir = await mkdtemp(path.join(tmpdir(), "v2-team-mailbox-"))
  const config = TeamModeConfigSchema.parse({ enabled: true, base_dir: baseDir })
  const spec = {
    version: 1,
    name: "team",
    createdAt: 1,
    leadAgentId: "lead",
    members: [
      {
        kind: "subagent_type",
        name: "lead",
        backendType: "in-process",
        subagent_type: "general-purpose",
        isActive: true,
      },
    ],
  } satisfies TeamSpec
  const state = await createRuntimeState(spec, "session-lead", "project", config)
  await transitionRuntimeState(
    state.teamRunId,
    (current) => ({ ...current, members: current.members.map((member) => ({ ...member, sessionId: "session-lead" })) }),
    config,
  )
  registerTeamSession("session-lead", { teamRunId: state.teamRunId, memberName: "lead", role: "lead" })
  const messageId = randomUUID()
  await sendMessage(
    { version: 1, messageId, from: "member", to: "lead", kind: "message", body: "hello", timestamp: 1 },
    state.teamRunId,
    config,
    { isLead: false, activeMembers: ["lead", "member"] },
  )
  const fake = createFakePluginContext()
  const admitted: Array<{ readonly id?: string; readonly text: string; readonly resume?: boolean | null }> = []
  const context = {
    ...fake.context,
    session: {
      ...fake.context.session,
      synthetic: async (message: { readonly id?: string; readonly text: string; readonly resume?: boolean | null }) => {
        admitted.push(message)
      },
    },
  }
  const transform = createMessagesTransformHandler({
    hooks: { teamMailboxInjector: createTeamMailboxInjector({}, config) },
  })
  const cleanup = await installSessionHooks(context, { "experimental.chat.messages.transform": transform } as Hooks, {
    warn: () => {},
  })
  try {
    // when
    const input = {
      sessionID: "session-lead",
      agent: "sisyphus",
      model: { providerID: "openai", id: "test" },
      system: [],
      messages: [{ id: "msg_1", role: "user", content: "prompt" }],
      options: {},
    }
    const output = await fake.triggerContext(input)
    await fake.triggerContext(input)
    // then
    expect(admitted).toHaveLength(1)
    expect(admitted[0]?.text).toContain(messageId)
    expect(admitted[0]?.resume).toBe(true)
    expect(output.messages).toEqual(input.messages)
  } finally {
    await cleanup()
    clearTeamSessionRegistry()
    await rm(baseDir, { recursive: true, force: true })
  }
})

test("#given a host admission conflict #then a scheduled retry admits the same message without another caller", async () => {
  const fake = createFakePluginContext()
  const conflict = Object.assign(new Error(), { _tag: "SubagentAdmission.Conflict", reason: "Child generation changed" })
  const receipt = Promise.withResolvers<readonly string[]>()
  const accepted: string[] = []
  let attempts = 0
  const context = {
    ...fake.context,
    session: {
      ...fake.context.session,
      synthetic: async ({ id }: { readonly id?: string }) => {
        if (++attempts === 1) throw conflict
        if (id) accepted.push(id)
      },
    },
  }
  mock.timers.enable({ apis: ["setTimeout"] })
  try {
    const first = await deliverNativeTeamMailbox(context, {
      sessionID: "retry-lead",
      source: "live",
      identity: { teamRunId: "team", memberName: "lead" },
      consume: async (admit) => {
        const deferred = await admit({ sessionID: "retry-lead", id: "msg_stored", text: "stored payload" }) === false
        const admitted = deferred ? [] : ["msg_stored"]
        if (!deferred) receipt.resolve(admitted)
        return { admitted, deferred }
      },
    })
    expect(first).toEqual([])
    expect(accepted).toEqual([])
    mock.timers.tick(250)
    expect(await receipt.promise).toEqual(["msg_stored"])
    mock.timers.tick(30_000)
    expect(accepted).toEqual(["msg_stored"])
  } finally {
    stopNativeTeamMailbox(context)
    mock.timers.reset()
  }
})
