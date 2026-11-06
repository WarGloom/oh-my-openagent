/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { TeamModeConfigSchema } from "../../config/schema/team-mode"
import type { TeamModeConfig } from "../../config/schema/team-mode"
import * as deleteTeamModule from "../../features/team-mode/team-runtime/delete-team"
import { clearTeamSessionRegistry, registerTeamSession } from "../../features/team-mode/team-session-registry"
import type { RuntimeState } from "../../features/team-mode/types"
import { loadRuntimeState, saveRuntimeState } from "../../features/team-mode/team-state-store/store"
import { createTeamLeadOrphanHandler } from "./team-lead-orphan-handler"
import { createNativeFixture } from "../../features/team-mode/team-runtime/shutdown-test-fixtures"
import { bindNativeTeamWorktrees } from "../../v2/native-team-worktrees"
import * as logger from "../../shared/logger"

const temporaryDirectories: string[] = []

async function createTemporaryBaseDir(): Promise<string> {
  const baseDir = await mkdtemp(path.join(tmpdir(), "team-lead-orphan-handler-"))
  temporaryDirectories.push(baseDir)
  return baseDir
}

function createConfig(baseDir: string): TeamModeConfig {
  return TeamModeConfigSchema.parse({ base_dir: baseDir, enabled: true })
}

function createRuntimeState(teamRunId: string): RuntimeState {
  return {
    version: 1,
    teamRunId,
    teamName: "team-alpha",
    specSource: "project",
    createdAt: 1,
    status: "active",
    leadSessionId: "lead-session",
    members: [
      {
        name: "worker",
        sessionId: "member-session",
        agentType: "general-purpose",
        status: "running",
        pendingInjectedMessageIds: [],
      },
    ],
    shutdownRequests: [],
    bounds: {
      maxMembers: 8,
      maxParallelMembers: 4,
      maxMessagesPerRun: 10000,
      maxWallClockMinutes: 120,
      maxMemberTurns: 500,
    },
  }
}

async function seedRuntimeState(runtimeState: RuntimeState, config: TeamModeConfig): Promise<void> {
  await mkdir(path.join(config.base_dir ?? "", "runtime", runtimeState.teamRunId), { recursive: true })
  await saveRuntimeState(runtimeState, config)
}

afterEach(async () => {
  mock.restore()
  clearTeamSessionRegistry()
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directoryPath) => {
      await rm(directoryPath, { recursive: true, force: true })
    }),
  )
})

describe("createTeamLeadOrphanHandler", () => {
  test("orphan cleanup keeps unintegrated native worktrees and reports their paths", async () => {
    // given
    const fixture = await createNativeFixture()
    temporaryDirectories.push(fixture.baseDir)
    const directory = fixture.worktreePaths[0]
    if (!directory) throw new Error("missing member worktree")
    await fixture.git(directory, "switch", "--detach", fixture.next)
    const manager = { getTasksByParentSession: () => [], cancelTask: mock(async () => true) }
    bindNativeTeamWorktrees(manager, fixture.worktrees)
    const logged = spyOn(logger, "log")
    const handler = createTeamLeadOrphanHandler(fixture.config, undefined, manager)

    // when
    await handler({ event: { type: "session.deleted", properties: { info: { id: "lead-session" } } } })

    // then
    await expect(loadRuntimeState(fixture.teamRunId, fixture.config)).rejects.toThrow()
    expect(await fixture.git(directory, "rev-parse", "HEAD")).toBe(fixture.next)
    expect(logged.mock.calls).toContainEqual([
      "team lead orphan cleanup completed",
      expect.objectContaining({
        keptWorktrees: [
          expect.objectContaining({ directory, member: "member-a", reason: expect.stringContaining("unintegrated") }),
        ],
      }),
    ])
  })

  test("#given the deleted session matches the lead #when the orphan handler runs #then it marks the team orphaned and force-deletes the team", async () => {
    // given
    const baseDir = await createTemporaryBaseDir()
    const config = createConfig(baseDir)
    const teamRunId = randomUUID()
    await seedRuntimeState(createRuntimeState(teamRunId), config)
    const deleteTeamSpy = spyOn(deleteTeamModule, "deleteTeam")
    deleteTeamSpy.mockResolvedValue({ removedLayout: true, removedWorktrees: [] })
    const handler = createTeamLeadOrphanHandler(config)

    // when
    await handler({
      event: {
        type: "session.deleted",
        properties: { info: { id: "lead-session" } },
      },
    })

    // then
    const runtimeState = await loadRuntimeState(teamRunId, config)
    expect(runtimeState.status).toBe("orphaned")
    expect(deleteTeamSpy).toHaveBeenCalledTimes(1)
    expect(deleteTeamSpy).toHaveBeenCalledWith(teamRunId, config, undefined, undefined, {
      force: true,
      worktreeCleanup: "preserve",
    })
  })

  test("#given the registry tracks a fresh lead session before disk state persists it #when the orphan handler runs #then it still marks the team orphaned and force-deletes it", async () => {
    // given
    const baseDir = await createTemporaryBaseDir()
    const config = createConfig(baseDir)
    const teamRunId = randomUUID()
    await seedRuntimeState(
      {
        ...createRuntimeState(teamRunId),
        leadSessionId: undefined,
      },
      config,
    )
    registerTeamSession("lead-session", {
      teamRunId,
      memberName: "lead",
      role: "lead",
    })
    const deleteTeamSpy = spyOn(deleteTeamModule, "deleteTeam")
    deleteTeamSpy.mockResolvedValue({ removedLayout: false, removedWorktrees: [] })
    const handler = createTeamLeadOrphanHandler(config)

    // when
    await handler({
      event: {
        type: "session.deleted",
        properties: { info: { id: "lead-session" } },
      },
    })

    // then
    const runtimeState = await loadRuntimeState(teamRunId, config)
    expect(runtimeState.status).toBe("orphaned")
    expect(deleteTeamSpy).toHaveBeenCalledTimes(1)
    expect(deleteTeamSpy).toHaveBeenCalledWith(teamRunId, config, undefined, undefined, {
      force: true,
      worktreeCleanup: "preserve",
    })
  })

  test("#given the registry points the lead session at the wrong teamRunId #when the orphan handler runs #then it falls back to disk lookup, orphans the correct team, and force-deletes it", async () => {
    // given
    const baseDir = await createTemporaryBaseDir()
    const config = createConfig(baseDir)
    const correctTeamRunId = randomUUID()
    const wrongTeamRunId = randomUUID()
    await seedRuntimeState(createRuntimeState(correctTeamRunId), config)
    await seedRuntimeState(
      {
        ...createRuntimeState(wrongTeamRunId),
        leadSessionId: "other-lead-session",
      },
      config,
    )
    registerTeamSession("lead-session", {
      teamRunId: wrongTeamRunId,
      memberName: "lead",
      role: "lead",
    })
    const deleteTeamSpy = spyOn(deleteTeamModule, "deleteTeam")
    deleteTeamSpy.mockResolvedValue({ removedLayout: false, removedWorktrees: [] })
    const handler = createTeamLeadOrphanHandler(config)

    // when
    await handler({
      event: {
        type: "session.deleted",
        properties: { info: { id: "lead-session" } },
      },
    })

    // then
    const correctRuntimeState = await loadRuntimeState(correctTeamRunId, config)
    const wrongRuntimeState = await loadRuntimeState(wrongTeamRunId, config)
    expect(correctRuntimeState.status).toBe("orphaned")
    expect(wrongRuntimeState.status).toBe("active")
    expect(deleteTeamSpy).toHaveBeenCalledTimes(1)
    expect(deleteTeamSpy).toHaveBeenCalledWith(correctTeamRunId, config, undefined, undefined, {
      force: true,
      worktreeCleanup: "preserve",
    })
  })
})
