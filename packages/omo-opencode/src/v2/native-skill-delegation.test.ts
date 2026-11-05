import { expect, test } from "bun:test"
import { createFakePluginContext } from "./fake-plugin-context"
import { createPluginInput } from "./create-plugin-input"
import { createSessionTracker } from "./session-tracker"
import { activateNativeSubagentSkills } from "./native-skill-delegation"
import type { V2SkillSnapshot } from "./native-skill-types"

const skill = { id: "native-id", name: "alias", path: "skill://native-id/SKILL.md", content: "unaccepted-catalog" }
const accepted: V2SkillSnapshot = {
  activationID: "host-activation",
  sessionID: "ses_child",
  agent: "atlas",
  source: { kind: "prompt", messageID: "child-prompt", selectionIndex: 0 },
  skill,
  arguments: "payload",
  revision: "accepted-revision",
  content: "accepted-expanded-payload",
  metadata: {},
}

test("delegation consumes host-admitted child text and stable activation IDs before native start", async () => {
  const fake = createFakePluginContext({
    skills: [skill],
    acceptSubagentSkills: async (input) =>
      input.admissionID === "prepared-admission" &&
      input.promptID === "child-prompt" &&
      input.skills[0]?.skill === skill.id &&
      input.skills[0]?.arguments === "payload"
        ? [accepted]
        : [],
  })
  const input = createPluginInput(fake.context, { tracker: createSessionTracker(), warn: () => {} })
  const result = await activateNativeSubagentSkills(input, {
    admissionID: "prepared-admission",
    promptID: "child-prompt",
    names: ["alias"],
    sessionID: "ses_child",
    agent: "atlas",
    arguments: "payload",
  })
  expect(result.text).toBe(accepted.content)
  expect(result.activationIDs).toEqual([accepted.activationID])
  expect(fake.permissionCalls).toEqual([])
  expect(fake.sessionCalls).toEqual([])
})

test.each([
  "native-denial",
  "incomplete",
  "wrong-session",
  "wrong-agent",
  "wrong-arguments",
  "wrong-index",
  "wrong-message",
])("delegation rejects %s receipts instead of falling back to local expansion", async (scenario) => {
  const denied = new Error("native permission denied")
  const fake = createFakePluginContext({
    skills: [skill],
    acceptSubagentSkills: async () => {
      if (scenario === "native-denial") throw denied
      if (scenario === "incomplete") return []
      return [
        {
          ...accepted,
          sessionID: scenario === "wrong-session" ? "ses_parent" : accepted.sessionID,
          agent: scenario === "wrong-agent" ? "sisyphus" : accepted.agent,
          arguments: scenario === "wrong-arguments" ? "changed" : accepted.arguments,
          source: {
            kind: "prompt",
            messageID: scenario === "wrong-message" ? "admission-default" : "child-prompt",
            selectionIndex: scenario === "wrong-index" ? 1 : 0,
          },
        },
      ]
    },
  })
  const input = createPluginInput(fake.context, { tracker: createSessionTracker(), warn: () => {} })
  const result = activateNativeSubagentSkills(input, {
    admissionID: "admission",
    promptID: "child-prompt",
    names: ["alias"],
    sessionID: "ses_child",
    agent: "atlas",
    arguments: "payload",
  })
  if (scenario === "native-denial") await expect(result).rejects.toBe(denied)
  else await expect(result).rejects.toThrow("receipt")
  expect(fake.permissionCalls).toEqual([])
})

test("command skill mentions keep their order while equivalent task names share native acceptance", async () => {
  const commandSkills = [
    { id: skill.id, arguments: "first", mention: { start: 0, end: 6, text: "/alias" } },
    { id: skill.id, arguments: "second", mention: { start: 8, end: 14, text: "/alias" } },
  ]
  const fake = createFakePluginContext({
    skills: [skill],
    acceptSubagentSkills: async (input) =>
      input.skills.map((selection, index) => ({
        ...accepted,
        activationID: `activation-${index}`,
        arguments: selection.arguments,
        content: `accepted-${selection.arguments}`,
        source: { kind: "prompt", messageID: "child-prompt", selectionIndex: index },
      })),
  })
  const input = createPluginInput(fake.context, { tracker: createSessionTracker(), warn: () => {} })
  const result = await activateNativeSubagentSkills(input, {
    admissionID: "admission",
    promptID: "child-prompt",
    names: ["alias", "native-id"],
    arguments: "first",
    commandSkills,
    sessionID: "ses_child",
    agent: "atlas",
  })
  expect(result.selections).toEqual(commandSkills)
  expect(result.activationIDs).toEqual(["activation-0", "activation-1"])
  expect(result.text).toBe("accepted-first\n\naccepted-second")
})
