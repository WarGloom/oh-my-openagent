import { expect, test } from "bun:test"
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import { createFakePluginContext } from "./fake-plugin-context"
import { createPluginInput } from "./create-plugin-input"
import { createSessionTracker } from "./session-tracker"
import { setNativeSkillOptions } from "./native-skill-state"
import { installNativeSkills } from "./native-skills"
import type { V2SkillActivation } from "./native-skill-types"

const sources: ReadonlyArray<V2SkillActivation["source"]> = [
  { kind: "session", messageID: "msg_session" },
  { kind: "prompt", messageID: "msg_prompt", selectionIndex: 1 },
  { kind: "tool", messageID: "msg_tool", callID: "call_tool" },
]

test.each(sources)(
  "activation expands $kind arguments without connecting MCP or duplicating host authorization",
  async (source) => {
    const fake = createFakePluginContext()
    const input = createPluginInput(fake.context, { tracker: createSessionTracker(), warn: () => {} })
    const secret = "credential-must-remain-private"
    let connects = 0
    setNativeSkillOptions(input, {
      directory: "/repo",
      skills: [
        {
          name: "fixture",
          scope: "config",
          mcpSourcePath: "/repo/declared/mcp.json",
          definition: { name: "fixture", template: "dynamic-$ARGUMENTS" },
          mcpConfig: { declared: { command: "not-executed", env: { TOKEN: secret } } },
        },
      ],
      mcpManager: unsafeTestValue({
        listTools: async () => {
          connects++
          return []
        },
      }),
    })
    await installNativeSkills(input)
    const skill = (await fake.context.skill.list()).data[0]
    if (!skill) throw new Error("Fixture skill missing")
    const payload = `${source.kind}-payload`
    const event = await fake.triggerSkillActivation({
      activationID: `activation-${source.kind}`,
      sessionID: "ses_child",
      agent: "atlas",
      source,
      skill,
      arguments: payload,
      content: skill.content,
      metadata: {},
      decision: { allow: true },
    })
    expect(event.content).toContain(`dynamic-${payload}`)
    expect(event.metadata["omo.skill"]).toMatchObject({
      id: "fixture",
      source: "/repo/declared/mcp.json",
      servers: ["declared"],
    })
    expect(JSON.stringify(event.metadata)).not.toContain(secret)
    expect(connects).toBe(0)
    expect(fake.permissionCalls).toEqual([])
  },
)
