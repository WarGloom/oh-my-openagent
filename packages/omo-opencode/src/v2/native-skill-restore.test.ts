import { expect, test } from "bun:test"
import { createFakePluginContext } from "./fake-plugin-context"
import { createPluginInput } from "./create-plugin-input"
import { createSessionTracker } from "./session-tracker"
import { restoreNativeSkills } from "./native-skill-restore"
import type { V2SkillSnapshot } from "./native-skill-types"

function snapshot(activationID: string, args: string): V2SkillSnapshot {
  return {
    activationID, sessionID: "ses_child", agent: "atlas", source: { kind: "session", messageID: activationID },
    skill: { id: "same-skill", name: "same-skill", path: "skill://same-skill/SKILL.md", content: "registry-content" },
    arguments: args, revision: "accepted-version", content: `frozen-${args}`, metadata: {},
  }
}

test("restart replays the requested accepted activation, not the latest invocation of the same skill", async () => {
  const first = snapshot("activation-first", "first-arguments")
  const second = snapshot("activation-second", "second-arguments")
  const fake = createFakePluginContext({ skillSnapshots: [first, second] })
  const input = createPluginInput(fake.context, { tracker: createSessionTracker(), warn: () => {} })
  const result = await restoreNativeSkills(input, { sessionID: "ses_child", agent: "atlas", activationIDs: [first.activationID] })
  expect(result.text).toBe(first.content)
  expect(result.resolved).toEqual([first])
  expect(fake.permissionCalls).toEqual([])
})

test.each(["missing-activation", "wrong-agent", "wrong-session"])("restart rejects %s without authorizing or reading the catalog", async (scenario) => {
  const accepted = snapshot("activation-first", "accepted")
  const fake = createFakePluginContext({ skillSnapshots: [accepted] })
  const input = createPluginInput(fake.context, { tracker: createSessionTracker(), warn: () => {} })
  await expect(restoreNativeSkills(input, {
    sessionID: scenario === "wrong-session" ? "ses_parent" : "ses_child",
    agent: scenario === "wrong-agent" ? "sisyphus" : "atlas",
    activationIDs: scenario === "missing-activation" ? ["unknown"] : [accepted.activationID],
  })).rejects.toThrow("unavailable")
  expect(fake.permissionCalls).toEqual([])
})
