import { expect, it, spyOn } from "bun:test"
import type { V2CommandBeforeEvent } from "../context-types"
import { createFakePluginContext } from "../fake-plugin-context"
import { registerPromptHook } from "../prompt-hook"
import { consumeNativeGoalCommandMarker, markNativeGoalCommand } from "../../plugin/command-execute-before"
import { installConfigBridge } from "./install-config-bridge"
import { applyCommandConfig } from "../../plugin-handlers/command-config-handler"
import { createAutoSlashCommandHook } from "../../hooks/auto-slash-command/hook"
import * as commandDiscovery from "../../tools/slashcommand/command-discovery"

it("intercepts native commands and preserves the synthetic goal marker through prompt preparation", async () => {
  // given
  const fake = createFakePluginContext()
  let consumed = false
  let invocations = 0
  const promptHook = await registerPromptHook(fake.context, { "chat.message": async (_input, output) => {
    consumed = consumeNativeGoalCommandMarker(output.parts)
  } }, () => {})
  const config = await installConfigBridge(fake.context, async () => {}, {
    warn: () => {},
    beforeCommand: async (input, output) => {
      expect(input.invocationID).toBe("native_goal_1")
      invocations += 1
      markNativeGoalCommand(output.parts)
      output.parts.push({ type: "file", url: "file:///work/plan.md", filename: "plan.md" })
    },
  })
  try {
    // when
    const event = await fake.triggerCommandBefore({
      invocationID: "native_goal_1", agent: "Sisyphus", name: "goal", sessionID: "ses_1", delivery: "queue", disposition: "continue",
      prompt: { text: "set objective", files: [{ uri: "file:///work/input.md", name: "input.md" }] }, metadata: { external: true },
    })
    const prepared = await fake.triggerPrompt({ sessionID: "ses_1", messageID: "message_1", prompt: { ...event.prompt }, metadata: event.metadata })
    // then
    expect(invocations).toBe(1)
    expect(consumed).toBe(true)
    expect(prepared.prompt.text).toBe("set objective")
    expect(prepared.metadata?.external).toBe(true)
    expect(event.prompt.files).toEqual([{ uri: "file:///work/input.md", name: "input.md" }, { uri: "file:///work/plan.md", name: "plan.md" }])
  } finally {
    await config()
    await promptHook.dispose()
  }
})

it("runs the command-before hook once for OMO commands after rendering their template", async () => {
  // given
  const fake = createFakePluginContext()
  let invocations = 0
  const config = await installConfigBridge(fake.context, async (value) => {
    value.command = { triage: { template: "Triage: $ARGUMENTS" } }
  }, { warn: () => {}, beforeCommand: async (_input, output) => { invocations += 1; output.parts.push({ type: "text", text: "hook context" }) } })
  try {
    // when
    const event = await fake.triggerCommandBefore({ invocationID: "omo_1", agent: "Sisyphus", name: "triage", sessionID: "ses_1", prompt: { text: "bug" }, delivery: "queue", disposition: "continue" })
    await fake.builtCommands().get("triage")?.execute(event)
    // then
    expect(invocations).toBe(1)
    expect(fake.sessionCalls).toEqual([{ kind: "prompt", input: { sessionID: "ses_1", text: "Triage: bug\nhook context", delivery: "queue" } }])
  } finally {
    await config()
  }
})

it("guards a host command that replaces an OMO-discovered command with the same name", async () => {
  // given
  const fake = createFakePluginContext()
  let guarded = false
  const dispose = await installConfigBridge(fake.context, async (config) => {
    config.command = { "qa-expand": { template: "Host: $ARGUMENTS" } }
    await applyCommandConfig({
      config, ctx: { directory: "/tmp" }, pluginConfig: { claude_code: { commands: false, skills: false } },
      pluginComponents: { commands: {}, skills: {}, agents: {}, mcpServers: {}, hooksConfigs: [], plugins: [], errors: [] },
    })
  }, { warn: () => {}, beforeCommand: async () => { guarded = true } })
  const host = await fake.context.command.transform((editor) => {
    editor.add({ name: "qa-expand", execute: async () => {} })
  })
  await fake.context.command.reload()
  try {
    // when
    await fake.triggerCommandBefore({
      invocationID: "host_command_1", agent: "parent", name: "qa-expand", sessionID: "ses_1",
      prompt: { text: "argument" }, delivery: "queue", disposition: "continue",
    })
    // then
    expect(guarded).toBe(true)
  } finally {
    await host.dispose()
    await dispose()
  }
})

it("delivers one OMO expansion through a native host that honors the expanded flag", async () => {
  // given
  const discovery = spyOn(commandDiscovery, "discoverCommandsSync").mockReturnValue([{
    name: "qa-expand", metadata: { name: "qa-expand", description: "" }, scope: "opencode-project",
    content: "QA_EXPAND_MARK $ARGUMENTS ${user_message} $SESSION_ID",
  }])
  const autoSlash = createAutoSlashCommandHook({ skills: [], directory: "/tmp" })
  const fake = createFakePluginContext()
  const dispose = await installConfigBridge(fake.context, async () => {}, {
    warn: () => {}, beforeCommand: autoSlash["command.execute.before"],
  })
  const event: V2CommandBeforeEvent & { expanded?: boolean } = {
    invocationID: "expanded_1", agent: "parent", name: "qa-expand", sessionID: "ses_expand",
    prompt: { text: "value" }, delivery: "queue", disposition: "continue",
  }
  try {
    // when
    await fake.triggerCommandBefore(event)
    const delivered = event.expanded ? event.prompt.text : `QA_EXPAND_MARK ${event.prompt.text}`
    // then
    expect(delivered.match(/QA_EXPAND_MARK/g)?.length).toBe(1)
    expect(delivered).toContain("value value ses_expand")
    expect(delivered).not.toContain("$SESSION_ID")
    expect(event.expanded).toBe(true)
  } finally {
    await dispose()
    autoSlash.dispose()
    discovery.mockRestore()
  }
})

it("awaits the native command guard before returning its rewritten prompt", async () => {
  // given
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const fake = createFakePluginContext()
  const dispose = await installConfigBridge(fake.context, async () => {}, {
    warn: () => {}, beforeCommand: async (_input, output) => {
      entered.resolve()
      await release.promise
      output.parts[0].text = "guarded"
    },
  })
  try {
    // when
    const pending = fake.triggerCommandBefore({
      invocationID: "awaited_1", agent: "parent", name: "host", sessionID: "ses_1",
      prompt: { text: "original" }, delivery: "queue", disposition: "continue",
    })
    await entered.promise
    release.resolve()
    // then
    expect((await pending).prompt.text).toBe("guarded")
  } finally {
    release.resolve()
    await dispose()
  }
})
