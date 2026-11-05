import { describe, expect, test } from "bun:test"
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import { createFakePluginContext } from "./fake-plugin-context"
import { createPluginInput } from "./create-plugin-input"
import { createSessionTracker } from "./session-tracker"
import { setNativeSkillOptions } from "./native-skill-state"
import { installNativeSkills } from "./native-skills"
import type { LoadedSkill } from "../features/opencode-skill-loader"
import type { V2ToolExecuteContext } from "./context-types"
import { createSkillContext } from "../plugin/skill-context"
import { OhMyOpenCodeConfigSchema } from "../config"
import { selectRuntimeSecuritySkills } from "../features/opencode-runtime-skills"

const invocation: V2ToolExecuteContext = {
  agent: "sisyphus",
  sessionID: "ses_parent",
  messageID: "msg_1",
  id: "call_1",
  signal: new AbortController().signal,
  progress: async () => {},
}

function loaded(name: string, template: string): LoadedSkill {
  return { name, scope: "config", definition: { name, template } }
}

async function fixture(options: Parameters<typeof createFakePluginContext>[0] = {}) {
  const fake = createFakePluginContext(options)
  const input = createPluginInput(fake.context, { tracker: createSessionTracker(), warn: () => {} })
  const native = { content: "native-result", metadata: { host: true } }
  await fake.context.tool.transform((editor) =>
    editor.add({
      name: "skill",
      description: "native",
      input: {},
      execute: async (args, ctx) => {
        await fake.context.permission.assert({
          action: "skill",
          resources: [args.id],
          sessionID: ctx.sessionID,
          agent: ctx.agent,
        })
        const skill = (await fake.context.skill.list()).data.find((entry) => entry.id === args.id)
        if (!skill) throw new Error("Native skill missing")
        const event = await fake.triggerSkillActivation({
          activationID: `${ctx.id}:${args.id}`,
          sessionID: ctx.sessionID,
          agent: ctx.agent,
          source: { kind: "tool", messageID: ctx.messageID, callID: ctx.id },
          skill,
          arguments: args.arguments,
          content: skill.content,
          metadata: {},
          decision: { allow: true },
        })
        if (!event.decision.allow) throw new Error(event.decision.reason)
        return args.id === "external" ? native : { ...native, content: event.content }
      },
    }),
  )
  return {
    fake,
    input,
    native,
    execute: async (args: unknown) => {
      const skill = (await fake.context.tool.list()).find((tool) => tool.id === "skill")
      if (!skill) throw new Error("Native skill tool missing")
      return skill.execute(args, invocation)
    },
  }
}

describe("native skill convergence", () => {
  test.each([
    { disabled: [] },
    { disabled: ["security-research"] },
    { disabled: ["security-review"] },
    { disabled: ["security-research", "security-review"] },
  ])(
    "registers selected runtime skills from the merged catalog with disabled skills $disabled",
    async ({ disabled }) => {
      const pluginConfig = OhMyOpenCodeConfigSchema.parse({ disabled_skills: disabled, claude_code: { skills: false } })
      const current = await fixture()
      const merged = await createSkillContext({ directory: "/tmp/native-runtime-skill-proof", pluginConfig })
      setNativeSkillOptions(current.input, {
        directory: "/tmp/native-runtime-skill-proof",
        skills: merged.mergedSkills,
        disabledSkills: merged.disabledSkills,
      })
      await installNativeSkills(current.input)
      const native = (await current.fake.context.skill.list()).data
      const selected = selectRuntimeSecuritySkills(pluginConfig)
        .map((skill) => skill.name)
        .sort()
      expect(
        native
          .filter((skill) => skill.id === "security-research" || skill.id === "security-review")
          .map((skill) => skill.id)
          .sort(),
      ).toEqual(selected)
    },
  )
  test("keeps host and plugin skills while reusing collision permission identities and restoring disposal state", async () => {
    const host = { id: "host-id", name: "shared", path: "skill://host-id/SKILL.md", content: "host" }
    const plugin = { id: "external", name: "external", path: "skill://external/SKILL.md", content: "plugin" }
    const current = await fixture({ skills: [host, plugin] })
    setNativeSkillOptions(current.input, {
      directory: "/repo",
      skills: [loaded("shared", "omo"), loaded("new", "added")],
    })
    const registration = await installNativeSkills(current.input)
    expect((await current.fake.context.skill.list()).data.map((skill) => skill.id)).toEqual([
      "host-id",
      "external",
      "new",
    ])
    await current.execute({ name: "shared" })
    expect(current.fake.permissionCalls[0]?.resources).toEqual(["host-id"])
    expect(await current.execute({ id: "external" })).toBe(current.native)
    await registration?.dispose()
    expect((await current.fake.context.skill.list()).data).toEqual([host, plugin])
  })

  test.each(["id", "name"] as const)("expands dynamic arguments through native %s invocation", async (key) => {
    const current = await fixture()
    setNativeSkillOptions(current.input, {
      directory: "/repo",
      skills: [loaded("template", "$ARGUMENTS ${user_message}")],
    })
    await installNativeSkills(current.input)
    const args = `payload-${key}-$&`
    const result = await current.execute({ [key]: "template", user_message: args })
    expect(result.content).toContain(`${args} ${args}`)
    expect(result.metadata).toEqual(current.native.metadata)
  })

  test("preserves resource denial before lazy expansion and MCP discovery", async () => {
    const denied = new Error("denied by host")
    const current = await fixture({
      permissionAssert: async () => {
        throw denied
      },
    })
    let discoveries = 0
    const skill = loaded("embedded", "body")
    skill.mcpConfig = { demo: { command: "not-executed" } }
    setNativeSkillOptions(current.input, {
      directory: "/repo",
      skills: [skill],
      mcpManager: unsafeTestValue({
        listTools: async () => {
          discoveries++
          return []
        },
        listResources: async () => [],
        listPrompts: async () => [],
      }),
    })
    await installNativeSkills(current.input)
    await expect(current.execute({ id: "embedded" })).rejects.toBe(denied)
    expect(discoveries).toBe(0)
  })

  test("expands command arguments through the existing formatter while skills win name collisions", async () => {
    const current = await fixture()
    setNativeSkillOptions(current.input, {
      directory: "/repo",
      skills: [loaded("collision", "skill-$ARGUMENTS")],
      commands: ["command", "collision"].map((name) => ({
        name,
        scope: "config",
        metadata: { name, description: "fixture" },
        content: "command-$ARGUMENTS",
      })),
    })
    await installNativeSkills(current.input)
    const command = await current.execute({ name: "command", user_message: "payload" })
    const collision = await current.execute({ name: "collision", user_message: "payload" })
    expect(command.content).toContain("command-payload")
    expect(collision.content).toBe("skill-payload")
  })

  test("rejects another agent and hides its restricted entry from autoinvoke", async () => {
    const current = await fixture()
    const skill = loaded("restricted", "private")
    skill.definition.agent = "atlas"
    setNativeSkillOptions(current.input, { directory: "/repo", skills: [skill] })
    await installNativeSkills(current.input)
    expect((await current.fake.context.skill.list()).data[0]?.autoinvoke).toBe(false)
    await expect(current.execute({ name: "restricted" })).rejects.toThrow('restricted to agent "atlas"')
  })

  test("native activation retains nonsecret MCP source metadata without early discovery", async () => {
    const current = await fixture()
    const skill = loaded("embedded", "dynamic-$ARGUMENTS")
    skill.mcpConfig = { demo: { command: "not-executed" } }
    skill.mcpSourcePath = "/declared/mcp.json"
    const seen: unknown[] = []
    setNativeSkillOptions(current.input, {
      directory: "/repo",
      skills: [skill],
      mcpManager: unsafeTestValue({
        listTools: async (info: unknown) => {
          seen.push(info)
          return [{ name: "available", inputSchema: { type: "object" } }]
        },
        listResources: async () => [],
        listPrompts: async () => [],
      }),
    })
    await installNativeSkills(current.input)
    const result = await current.fake.context.experimental.skill.activate({
      sessionID: "ses_child",
      skill: "embedded",
      arguments: "value",
      resume: false,
    })
    expect(result.content).toContain("dynamic-value")
    expect(result.metadata["omo.skill"]).toMatchObject({ source: "/declared/mcp.json", servers: ["demo"] })
    expect(seen).toEqual([])
    expect(current.fake.permissionCalls[0]).toMatchObject({ resources: ["embedded"], agent: "sisyphus" })
  })
})
