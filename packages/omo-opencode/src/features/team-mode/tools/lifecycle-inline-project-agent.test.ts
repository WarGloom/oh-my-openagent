/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"

import { parseInlineTeamSpec } from "./lifecycle-inline-spec"
import { createTeamCreateTool } from "./lifecycle-create-tool"
import { replaceProjectAgentProvenance } from "../final-open-code-agent-registry"
import {
  backgroundManager,
  config,
  createTeamRunMock,
  createToolContext,
  listActiveTeamsMock,
  loadRuntimeStateMock,
  loadTeamSpecMock,
  mockClient,
  resetLifecycleTestState,
} from "./lifecycle-test-fixture"

describe("inline project agent validation", () => {
  test("uses only the trusted current primary caller as a custom lead", async () => {
    resetLifecycleTestState()
    replaceProjectAgentProvenance("/project", ["orchestrator", "other-primary"])
    const client = { ...mockClient, app: { ...mockClient.app, agents: async () => ({ data: [{
      name: "orchestrator", mode: "primary", native: false, hidden: false,
      permission: [{ permission: "team_*", pattern: "*", action: "allow" }],
    }] }) } }
    const tool = createTeamCreateTool(config, client, backgroundManager, undefined, undefined, {
      createTeamRun: createTeamRunMock, loadTeamSpec: loadTeamSpecMock,
      listActiveTeams: listActiveTeamsMock, loadRuntimeState: loadRuntimeStateMock,
    })
    const context = { ...createToolContext("current-session"), agent: "orchestrator" }
    await tool.execute({ inline_spec: { name: "trusted-team", members: [{ name: "worker", category: "quick", prompt: "Inspect task" }] } }, context)
    expect(createTeamRunMock.mock.calls[0]?.[0].members[0]).toMatchObject({ name: "lead", subagent_type: "orchestrator" })
    expect(createTeamRunMock.mock.calls[0]?.[1]).toBe("current-session")
    await expect(tool.execute({ inline_spec: { name: "spoofed-team", lead: { name: "lead", subagent_type: "other-primary" }, members: [{ name: "worker", category: "quick", prompt: "Inspect task" }] } }, context)).rejects.toThrow("cannot be a team lead")
    expect(createTeamRunMock).toHaveBeenCalledTimes(1)
  })

  test("nonqualifying custom caller can still launch an explicit builtin lead but cannot implicitly lead", async () => {
    resetLifecycleTestState()
    const tool = createTeamCreateTool(config, mockClient, backgroundManager, undefined, undefined, {
      createTeamRun: createTeamRunMock, loadTeamSpec: loadTeamSpecMock,
      listActiveTeams: listActiveTeamsMock, loadRuntimeState: loadRuntimeStateMock,
    })
    const context = { ...createToolContext("launcher-session"), agent: "unregistered-launcher" }
    const members = [{ name: "worker", category: "quick", prompt: "Inspect task" }]
    await tool.execute({ inline_spec: { name: "launcher-team", lead: { name: "lead", subagent_type: "sisyphus" }, members } }, context)
    expect(createTeamRunMock).toHaveBeenCalledTimes(1)
    await expect(tool.execute({ inline_spec: { name: "implicit-launcher-team", members } }, context)).rejects.toThrow("not eligible as team lead")
    expect(createTeamRunMock).toHaveBeenCalledTimes(1)
  })

  test("allows an inline spec to carry an unknown project subagent type", () => {
    // given
    const rawSpec = {
      name: "inline-project-agents",
      leadAgentId: "lead",
      members: [
        { kind: "category", name: "lead", category: "deep", prompt: "Lead the inline project agent team." },
        { kind: "subagent_type", name: "worker", subagent_type: "project-worker" },
      ],
    }

    // when
    const spec = parseInlineTeamSpec(rawSpec)

    // then
    expect(spec.members[1]).toMatchObject({
      kind: "subagent_type",
      name: "worker",
      subagent_type: "project-worker",
    })
  })

  test("team_create rejects an inline spec whose explicit lead is an unknown project subagent type", async () => {
    // given: an inline spec that names a project (unknown) subagent as the team lead
    resetLifecycleTestState()
    const tool = createTeamCreateTool(
      config,
      mockClient,
      backgroundManager,
      undefined,
      undefined,
      {
        createTeamRun: createTeamRunMock,
        loadTeamSpec: loadTeamSpecMock,
        listActiveTeams: listActiveTeamsMock,
        loadRuntimeState: loadRuntimeStateMock,
      },
    )
    const inlineSpec = {
      name: "inline-project-lead",
      leadAgentId: "lead",
      members: [
        { kind: "subagent_type", name: "lead", subagent_type: "project-worker" },
        { kind: "category", name: "worker", category: "quick", prompt: "Do the assigned work." },
      ],
    }

    // when
    const result = tool.execute({ inline_spec: inlineSpec }, { ...createToolContext("lead-session"), agent: "sisyphus" })

    // then: the explicit project/unknown lead must be rejected before any caller-lead reuse or member spawn
    await expect(result).rejects.toThrow("cannot be a team lead")
    expect(createTeamRunMock).not.toHaveBeenCalled()
  })

  test("team_create rejects inherited caller eligibility before explicit known-lead reuse", async () => {
    // given: constructor inherits a registry-shaped value through Object.prototype
    resetLifecycleTestState()
    const tool = createTeamCreateTool(
      config,
      mockClient,
      backgroundManager,
      undefined,
      undefined,
      {
        createTeamRun: createTeamRunMock,
        loadTeamSpec: loadTeamSpecMock,
        listActiveTeams: listActiveTeamsMock,
        loadRuntimeState: loadRuntimeStateMock,
      },
    )
    const inlineSpec = {
      name: "inherited-caller-lead",
      leadAgentId: "lead",
      members: [
        { kind: "subagent_type", name: "lead", subagent_type: "sisyphus" },
        { kind: "category", name: "worker", category: "quick", prompt: "Do the assigned work." },
      ],
    }
    const toolContext = { ...createToolContext("lead-session"), agent: "constructor" }

    // when
    const result = tool.execute({ inline_spec: inlineSpec }, toolContext)

    // then
    await expect(result).rejects.toThrow("caller")
    expect(createTeamRunMock).not.toHaveBeenCalled()
  })
})
