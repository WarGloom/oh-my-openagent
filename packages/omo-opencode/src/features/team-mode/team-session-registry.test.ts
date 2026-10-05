/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { TeamModeConfigSchema } from "../../config/schema/team-mode"
import { RuntimeStateSchema } from "@oh-my-opencode/team-core/types"
import { dispatchInternalPrompt, releaseAllPromptAsyncReservationsForTesting } from "../../shared/prompt-async-gate"

import {
  clearTeamSessionRegistry,
  configureTeamSessionRemoval,
  hasActiveTeamMemberWork,
  isTeamSessionDenied,
  lookupTeamSession,
  registerTeamSession,
  unregisterTeamSession,
  unregisterTeamSessionsByTeam,
} from "./team-session-registry"

describe("team-session-registry", () => {
  afterEach(() => {
    clearTeamSessionRegistry()
  })

  test("registers a session and looks it up by sessionId", () => {
    // given
    registerTeamSession("ses_alpha", { teamRunId: "team-1", memberName: "worker-1", role: "member" })

    // when
    const entry = lookupTeamSession("ses_alpha")

    // then
    expect(entry).toEqual({ teamRunId: "team-1", memberName: "worker-1", role: "member" })
  })

  test("returns undefined when the sessionId is not registered", () => {
    // given - nothing registered
    // when
    const entry = lookupTeamSession("ses_missing")

    // then
    expect(entry).toBeUndefined()
  })

  test("unregisters a single session by sessionId", () => {
    // given
    registerTeamSession("ses_alpha", { teamRunId: "team-1", memberName: "lead", role: "lead" })
    registerTeamSession("ses_beta", { teamRunId: "team-1", memberName: "worker-1", role: "member" })

    // when
    unregisterTeamSession("ses_alpha")

    // then
    expect(lookupTeamSession("ses_alpha")).toBeUndefined()
    expect(lookupTeamSession("ses_beta")).toEqual({ teamRunId: "team-1", memberName: "worker-1", role: "member" })
  })

  test("unregisters every session that belongs to the given teamRunId", () => {
    // given
    registerTeamSession("ses_alpha", { teamRunId: "team-1", memberName: "lead", role: "lead" })
    registerTeamSession("ses_beta", { teamRunId: "team-1", memberName: "worker-1", role: "member" })
    registerTeamSession("ses_gamma", { teamRunId: "team-2", memberName: "solo", role: "member" })

    // when
    unregisterTeamSessionsByTeam("team-1")

    // then
    expect(lookupTeamSession("ses_alpha")).toBeUndefined()
    expect(lookupTeamSession("ses_beta")).toBeUndefined()
    expect(lookupTeamSession("ses_gamma")).toEqual({ teamRunId: "team-2", memberName: "solo", role: "member" })
  })

  test("clearTeamSessionRegistry removes every entry", () => {
    // given
    registerTeamSession("ses_alpha", { teamRunId: "team-1", memberName: "lead", role: "lead" })
    registerTeamSession("ses_beta", { teamRunId: "team-2", memberName: "worker", role: "member" })

    // when
    clearTeamSessionRegistry()

    // then
    expect(lookupTeamSession("ses_alpha")).toBeUndefined()
    expect(lookupTeamSession("ses_beta")).toBeUndefined()
  })

  test("registering the same sessionId twice overwrites the previous entry", () => {
    // given
    registerTeamSession("ses_alpha", { teamRunId: "team-1", memberName: "worker-1", role: "member" })

    // when
    registerTeamSession("ses_alpha", { teamRunId: "team-2", memberName: "promoted-lead", role: "lead" })

    // then
    expect(lookupTeamSession("ses_alpha")).toEqual({ teamRunId: "team-2", memberName: "promoted-lead", role: "lead" })
  })
})

test.each(["json", "schema"])("removal correction: unrelated malformed %s state does not block ordinary dispatch or healthy denial", async malformed => {
  // given
  const root = await mkdtemp(path.join(tmpdir(), "removal-context-"))
  const config = TeamModeConfigSchema.parse({ enabled: true, base_dir: root })
  const run = crypto.randomUUID()
  const state = RuntimeStateSchema.parse({ version: 1, teamRunId: run, teamName: "alpha", specSource: "project", createdAt: 1,
    status: "active", members: [{ name: "retired", sessionId: "retired-session", agentType: "general-purpose", status: "running",
      removal: { operationId: crypto.randomUUID(), sessionId: "retired-session", startedAt: 1, phase: "fenced", taskIds: [] },
    }, { name: "healthy", sessionId: "healthy-session", agentType: "general-purpose", status: "running" }], bounds: {},
  })
  await mkdir(path.join(root, "runtime", run), { recursive: true })
  await writeFile(path.join(root, "runtime", run, "state.json"), JSON.stringify(state))
  configureTeamSessionRemoval(config)
  registerTeamSession("healthy-session", { teamRunId: run, memberName: "healthy", role: "member" })
  const unrelated = crypto.randomUUID()
  await mkdir(path.join(root, "runtime", unrelated))
  await writeFile(path.join(root, "runtime", unrelated, "state.json"), malformed === "json" ? "{" : JSON.stringify({ ...state, teamRunId: unrelated, version: 999, members: [] }))
  // when / then
  try {
    let sends = 0
    const result = await dispatchInternalPrompt({ mode: "async", sessionID: "ordinary-session", source: "correction-test", input: {}, settleMs: 0,
      client: { session: { promptAsync: async () => { sends += 1 } } },
    })
    expect(result.status).toBe("dispatched")
    expect(sends).toBe(1)
    expect(isTeamSessionDenied("retired-session")).toBe(true)
    expect(lookupTeamSession("healthy-session")).toMatchObject({ teamRunId: run, memberName: "healthy" })
    await writeFile(path.join(root, "runtime", run, "state.json"), JSON.stringify({ ...state, version: 999 }))
    expect(isTeamSessionDenied("retired-session")).toBe(true)
    expect(isTeamSessionDenied("healthy-session")).toBe(true)
    expect(isTeamSessionDenied("ordinary-session")).toBe(false)
  } finally {
    clearTeamSessionRegistry()
    releaseAllPromptAsyncReservationsForTesting()
    await rm(root, { recursive: true, force: true })
  }
})

test("removal correction: two cold roots retain authority when a second context is disabled", async () => {
  // given
  const rootA = await mkdtemp(path.join(tmpdir(), "removal-root-a-"))
  const rootB = await mkdtemp(path.join(tmpdir(), "removal-root-b-"))
  const configA = TeamModeConfigSchema.parse({ enabled: true, base_dir: rootA })
  const configB = TeamModeConfigSchema.parse({ enabled: true, base_dir: rootB })
  const run = crypto.randomUUID()
  const state = RuntimeStateSchema.parse({ version: 1, teamRunId: run, teamName: "alpha", specSource: "project", createdAt: 1,
    status: "active", members: [{ name: "retired", sessionId: "retired-a", agentType: "general-purpose", status: "running",
      removal: { operationId: crypto.randomUUID(), sessionId: "retired-a", startedAt: 1, phase: "fenced", taskIds: [] },
    }, { name: "healthy", sessionId: "healthy-a", agentType: "general-purpose", status: "running" }], bounds: {},
  })
  await mkdir(path.join(rootA, "runtime", run), { recursive: true })
  await writeFile(path.join(rootA, "runtime", run, "state.json"), JSON.stringify(state))
  clearTeamSessionRegistry()
  configureTeamSessionRemoval(configA)
  registerTeamSession("healthy-a", { teamRunId: run, memberName: "healthy", role: "member" })
  // when / then
  try {
    configureTeamSessionRemoval(configB)
    expect(isTeamSessionDenied("retired-a")).toBe(true)
    expect(lookupTeamSession("healthy-a")).toMatchObject({ teamRunId: run, memberName: "healthy" })
    configureTeamSessionRemoval({ ...configB, enabled: false })
    configureTeamSessionRemoval(undefined)
    expect(isTeamSessionDenied("retired-a")).toBe(true)
    expect(isTeamSessionDenied("retired-a", { ...configB, enabled: false })).toBe(true)
    expect(lookupTeamSession("healthy-a")).toMatchObject({ teamRunId: run, memberName: "healthy" })
  } finally {
    clearTeamSessionRegistry()
    await Promise.all([rootA, rootB].map(root => rm(root, { recursive: true, force: true })))
  }
})

test("hasActiveTeamMemberWork reports only working non-lead members of an active run led by the session", async () => {
  // given
  const root = await mkdtemp(path.join(tmpdir(), "team-member-work-"))
  const config = TeamModeConfigSchema.parse({ enabled: true, base_dir: root })
  const run = crypto.randomUUID()
  const stateFor = (memberStatus: string, runStatus = "active") => RuntimeStateSchema.parse({ version: 1, teamRunId: run, teamName: "alpha",
    specSource: "project", createdAt: 1, status: runStatus, leadSessionId: "lead-session", bounds: {}, members: [
      { name: "lead", sessionId: "lead-session", agentType: "general-purpose", status: "running" },
      { name: "worker", sessionId: "worker-session", agentType: "general-purpose", status: memberStatus },
    ] })
  const write = (memberStatus: string, runStatus?: string) =>
    writeFile(path.join(root, "runtime", run, "state.json"), JSON.stringify(stateFor(memberStatus, runStatus)))
  await mkdir(path.join(root, "runtime", run), { recursive: true })
  try {
    // when / then
    await write("running")
    expect(hasActiveTeamMemberWork("lead-session", config)).toBe(true)
    expect(hasActiveTeamMemberWork("worker-session", config)).toBe(false)
    expect(hasActiveTeamMemberWork("other-session", config)).toBe(false)
    await write("idle")
    expect(hasActiveTeamMemberWork("lead-session", config)).toBe(false)
    await write("running", "shutdown_requested")
    expect(hasActiveTeamMemberWork("lead-session", config)).toBe(false)
  } finally {
    clearTeamSessionRegistry()
    await rm(root, { recursive: true, force: true })
  }
})
