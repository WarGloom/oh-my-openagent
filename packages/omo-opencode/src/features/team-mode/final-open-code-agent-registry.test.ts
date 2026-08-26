/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"

import {
  hasProjectAgentProvenance,
  replaceProjectAgentProvenance,
} from "./final-open-code-agent-registry"

describe("project agent provenance", () => {
  test("accepts a parent snapshot from a descendant member-worktree path", () => {
    // given: a project snapshot recorded above a member worktree
    const projectDirectory = "/tmp/test-project-agent-provenance-parent"
    const memberWorktreeDirectory = `${projectDirectory}/.omo/teams/example/worktrees/member`
    replaceProjectAgentProvenance(projectDirectory, ["project-agent"])

    // when: provenance is checked from the descendant member worktree
    const result = hasProjectAgentProvenance(memberWorktreeDirectory, "project-agent")

    // then: the parent project snapshot authorizes the agent
    expect(result).toBe(true)
  })

  test("rejects when the nearest snapshot does not contain the agent", () => {
    // given: an older matching snapshot and a nearer nonmatching snapshot
    const projectDirectory = "/tmp/test-project-agent-provenance-nonmatching"
    const nestedDirectory = `${projectDirectory}/nested`
    replaceProjectAgentProvenance(projectDirectory, ["project-agent"])
    replaceProjectAgentProvenance(nestedDirectory, ["other-agent"])

    // when: provenance is checked below the nearer snapshot
    const result = hasProjectAgentProvenance(`${nestedDirectory}/member`, "project-agent")

    // then: the nearer snapshot blocks the older ancestor
    expect(result).toBe(false)
  })

  test("rejects when the nearest snapshot is empty", () => {
    // given: an older matching snapshot and a nearer empty snapshot
    const projectDirectory = "/tmp/test-project-agent-provenance-empty"
    const nestedDirectory = `${projectDirectory}/nested`
    replaceProjectAgentProvenance(projectDirectory, ["project-agent"])
    replaceProjectAgentProvenance(nestedDirectory, [])

    // when: provenance is checked below the nearer snapshot
    const result = hasProjectAgentProvenance(`${nestedDirectory}/member`, "project-agent")

    // then: the empty snapshot blocks the older ancestor
    expect(result).toBe(false)
  })

  test("rejects a sibling-prefix path", () => {
    // given: a registered project and a sibling whose name shares its prefix
    const projectDirectory = "/tmp/test-project-agent-provenance-sibling"
    replaceProjectAgentProvenance(projectDirectory, ["project-agent"])

    // when: provenance is checked from the sibling-prefix path
    const result = hasProjectAgentProvenance(`${projectDirectory}-other/member`, "project-agent")

    // then: lexical prefix similarity does not authorize the sibling
    expect(result).toBe(false)
  })
})
