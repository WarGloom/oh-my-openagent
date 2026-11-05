import { expect, test } from "bun:test"
import { createFakePluginContext } from "./fake-plugin-context"
import { createPluginInput } from "./create-plugin-input"
import { createSessionTracker } from "./session-tracker"
import { getNativeSkillState, setNativeSkillOptions } from "./native-skill-state"
import { installNativeSkills } from "./native-skills"
import { getAcceptedNativeSkillMcps, resolveAcceptedSkillMcp } from "./native-skill-mcp"
import type { V2SkillSnapshot } from "./native-skill-types"

async function fixture(command = "declared", snapshots: ReadonlyArray<V2SkillSnapshot> = []) {
  const fake = createFakePluginContext({ skillSnapshots: snapshots, sessionAgent: "atlas" })
  const input = createPluginInput(fake.context, { tracker: createSessionTracker(), warn: () => {} })
  setNativeSkillOptions(input, {
    directory: "/repo", skills: [{
      name: "fixture", scope: "config", definition: { name: "fixture", template: "body", agent: "atlas" },
      mcpConfig: { server: { command } },
    }],
  })
  await installNativeSkills(input)
  const state = getNativeSkillState(input)
  const skill = (await fake.context.skill.list()).data[0]
  if (!state || !skill) throw new Error("Fixture initialization failed")
  const event = await fake.triggerSkillActivation({
    activationID: "activation-1", sessionID: "ses_child", agent: "atlas", source: { kind: "session", messageID: "msg_1" },
    skill, content: skill.content, metadata: {}, decision: { allow: true },
  })
  const snapshot: V2SkillSnapshot = { ...event, revision: "host-registry-version" }
  return { state, snapshot, input, fake }
}

test("accepted snapshots restore only target-session declared MCP bindings after reload", async () => {
  const original = await fixture()
  const reloaded = await fixture()
  const invocation = { sessionID: "ses_child", agent: "atlas" }
  const first = resolveAcceptedSkillMcp(original.state, invocation, [original.snapshot])
  const restored = resolveAcceptedSkillMcp(reloaded.state, invocation, [original.snapshot, original.snapshot])
  expect(restored).toHaveLength(1)
  expect(restored[0]?.revision).toBe(first[0]?.revision)
  expect(restored[0]?.skill.mcpConfig).toEqual({ server: { command: "declared" } })
})

test("the public native snapshot reader, not prepared hook metadata, authorizes MCP restoration", async () => {
  const original = await fixture()
  const invocation = { sessionID: "ses_child", agent: "atlas" }
  expect(await getAcceptedNativeSkillMcps(original.input, invocation)).toEqual([])
  const accepted = await fixture("declared", [original.snapshot])
  expect(await getAcceptedNativeSkillMcps(accepted.input, invocation)).toHaveLength(1)
})

test("only completed native activation admits a descriptor for the target MCP resolver", async () => {
  const current = await fixture()
  const invocation = { sessionID: "ses_child", agent: "atlas" }
  expect(await getAcceptedNativeSkillMcps(current.input, invocation)).toEqual([])
  await current.fake.context.experimental.skill.activate({ sessionID: "ses_child", skill: "fixture", activationID: "stable", resume: false })
  expect(await getAcceptedNativeSkillMcps(current.input, invocation)).toHaveLength(1)
  expect(current.fake.permissionCalls).toHaveLength(1)
})

test.each([
  { content: "body\n", accepted: true },
  { content: "different body", accepted: false },
])("host registry content $content admits child MCP bindings only when identity matches", async ({ content, accepted }) => {
  const current = await fixture()
  const skill = current.snapshot.skill
  await current.fake.context.skill.transform((editor) => editor.add({ ...skill, content }))

  const snapshot = await current.fake.context.experimental.skill.activate({ sessionID: "ses_child", skill: skill.id, resume: false })

  if (accepted) expect(snapshot.metadata["omo.skill"]).toMatchObject({ id: skill.id, servers: ["server"] })
  else expect(snapshot.metadata["omo.skill"]).toBeUndefined()
  const bindings = await getAcceptedNativeSkillMcps(current.input, { sessionID: "ses_child", agent: "atlas" })
  expect(bindings.map((entry) => entry.skill.mcpConfig)).toEqual(accepted ? [{ server: { command: "declared" } }] : [])
})

test.each(["unaccepted", "parent-session", "wrong-agent", "undeclared-server", "changed-source", "changed-content"])("rejects %s MCP access", async (scenario) => {
  const original = await fixture()
  const state = scenario === "changed-source" ? (await fixture("changed-command")).state : original.state
  const metadata = structuredClone(original.snapshot.metadata)
  const skill = scenario === "changed-content" ? { ...original.snapshot.skill, content: "different body" } : original.snapshot.skill
  if (scenario === "undeclared-server") {
    const descriptor = metadata["omo.skill"]
    if (typeof descriptor !== "object" || descriptor === null || Array.isArray(descriptor)) throw new Error("Descriptor missing")
    descriptor.servers = ["extra-server"]
  }
  const result = resolveAcceptedSkillMcp(state, {
    sessionID: scenario === "parent-session" ? "ses_parent" : "ses_child",
    agent: scenario === "wrong-agent" ? "sisyphus" : "atlas",
  }, scenario === "unaccepted" ? [] : [{ ...original.snapshot, skill, metadata }])
  expect(result).toEqual([])
})
