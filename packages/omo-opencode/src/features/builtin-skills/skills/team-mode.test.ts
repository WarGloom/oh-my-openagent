import { describe, expect, test } from "bun:test"

import { createBuiltinSkills } from "../skills"
import { teamModeSkill } from "./team-mode"

describe("teamModeSkill gating", () => {
  test("team-mode hidden when disabled", () => {
    // given
    const options = {
      teamModeEnabled: false,
      disabledSkills: new Set<string>(),
    }

    // when
    const skills = createBuiltinSkills(options)

    // then
    expect(skills.some((skill) => skill.name === "team-mode")).toBe(false)
  })

  test("team-mode visible when enabled", () => {
    // given
    const options = {
      teamModeEnabled: true,
      disabledSkills: new Set<string>(),
    }

    // when
    const skills = createBuiltinSkills(options)

    // then
    const skill = skills.find((candidateSkill) => candidateSkill.name === "team-mode")
    expect(skill).toBeDefined()
    expect(skill?.name).toBe("team-mode")
    expect(skill?.description).toBe(teamModeSkill.description)
  })

  test("team-mode skill has no mcpConfig", () => {
    // given

    // when
    const skill = teamModeSkill

    // then
    expect(skill.mcpConfig).toBeUndefined()
  })

  test("team-mode skill body keeps required keywords", () => {
    // given
    const body = teamModeSkill.template

    // when
    const keywords = [
      "TeamSpec",
      "member",
      "category",
      "subagent_type",
      "sisyphus",
      "atlas",
      "hephaestus",
      "oracle",
      "eligible",
    ]

    // then
    for (const keyword of keywords) {
      expect(body).toContain(keyword)
    }
  })

  test("team-mode skill separates lead-only and member-safe tools", () => {
    // given
    const body = teamModeSkill.template

    // when
    const leadOnlyTools = ["team_create", "team_delete", "team_shutdown_request"]
    const universalTools = [
      "team_send_message",
      "team_task_create",
      "team_task_list",
      "team_task_update",
      "team_task_get",
      "team_status",
    ]

    // then
    expect(body).toContain("## Lead-only tools")
    expect(body).toContain("## Universal team-run tools")
    expect(body).toContain("## Global query tool")
    for (const toolName of leadOnlyTools) {
      expect(body).toContain(toolName)
    }
    for (const toolName of universalTools) {
      expect(body).toContain(toolName)
    }
    expect(body).not.toContain("team_shutdown_request - ask the lead to wind down")
  })

  test("team-mode skill distinguishes independent task fanout from coordinated teams", () => {
    // given
    const body = teamModeSkill.template

    // when
    const independentFanoutGuidance = body.includes("independent read-only searches")
      && body.includes("run_in_background=true")
      && body.includes("Team mode is for shared task state")

    // then
    expect(independentFanoutGuidance).toBe(true)
  })

  test("team-mode skill inline example omits unused optional member keys", () => {
    // given
    const body = teamModeSkill.template

    // when
    const runtimeSafeExampleIndex = body.indexOf("Runtime-safe inline example")
    const declaredTeamSpecIndex = body.indexOf("Declared TeamSpec files")
    const runtimeSafeExample = body.slice(runtimeSafeExampleIndex, declaredTeamSpecIndex)

    // then
    expect(runtimeSafeExampleIndex).toBeGreaterThanOrEqual(0)
    expect(declaredTeamSpecIndex).toBeGreaterThan(runtimeSafeExampleIndex)
    expect(runtimeSafeExample).toContain('"category": "quick"')
    expect(runtimeSafeExample).toContain('"prompt":')
    expect(runtimeSafeExample).not.toContain("subagent_type")
    expect(runtimeSafeExample).not.toContain('"kind"')
    expect(body).toContain("Do not include unrelated member keys with empty-string values")
  })
})
