/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { access, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { createNativeFixture } from "./shutdown-test-fixtures"
import { bindNativeTeamWorktrees } from "../../../v2/native-team-worktrees"
import { loadRuntimeState, transitionRuntimeState } from "../team-state-store/store"
import { getRuntimeStateDir } from "../team-registry/paths"

import { TeamModeConfigSchema } from "../../../config/schema/team-mode"
import type { BackgroundManager } from "../../background-agent/manager"
import type { TmuxSessionManager } from "../../tmux-subagent/manager"
import type { deleteTeam } from "./delete-team"
import {
  cleanupSessionTeamRuns,
  clearSessionTeamRunCleanupRegistry,
  getSessionCreatedTeamRunIds,
  registerTeamRunForSessionCleanup,
} from "./session-cleanup"

describe("session team cleanup", () => {
  const directories: string[] = []
  beforeEach(() => {
    clearSessionTeamRunCleanupRegistry()
  })

  afterEach(async () => {
    clearSessionTeamRunCleanupRegistry()
    mock.restore()
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  test("session cleanup reports dirty native worktrees and preserves them inside the runtime directory", async () => {
    // given
    const fixture = await createNativeFixture()
    directories.push(fixture.baseDir)
    const original = fixture.worktreePaths[0]
    if (!original) throw new Error("missing member worktree")
    const directory = path.join(getRuntimeStateDir(fixture.baseDir, fixture.teamRunId), "member-work")
    await fixture.git(fixture.directory, "worktree", "move", original, directory)
    fixture.worktreePaths[0] = directory
    await transitionRuntimeState(fixture.teamRunId, (state) => ({ ...state, members: state.members.map((member) =>
      member.nativeWorktree?.directory === original ? { ...member, worktreePath: directory, nativeWorktree: { ...member.nativeWorktree, directory } } : member,
    ) }), fixture.config)
    await writeFile(path.join(directory, "unfinished.txt"), "member work")
    const manager = { getTasksByParentSession: () => [], cancelTask: mock(async () => true) }
    bindNativeTeamWorktrees(manager, fixture.worktrees)
    registerTeamRunForSessionCleanup(fixture.teamRunId)

    // when
    const report = await cleanupSessionTeamRuns({ config: fixture.config, bgMgr: manager })

    // then
    expect(report.cleanedTeamRunIds).toEqual([fixture.teamRunId])
    expect(report.keptWorktrees).toMatchObject([{ directory, member: "member-a", dirty: true }])
    expect(report.errors).toEqual([])
    await access(path.join(directory, "unfinished.txt"))
    await expect(loadRuntimeState(fixture.teamRunId, fixture.config)).rejects.toThrow()
  })

  test("#given team runs created in this process #when session cleanup runs #then it force deletes them with the tmux visualizer manager", async () => {
    // given
    const config = TeamModeConfigSchema.parse({ enabled: true, tmux_visualization: true })
    const tmuxMgr = { getServerUrl: () => "http://127.0.0.1:4096" } as TmuxSessionManager
    const bgMgr = { cancelTask: mock(async () => true) } as BackgroundManager
    const deleteTeamMock = mock(async () => ({
      removedLayout: true,
      removedWorktrees: [],
    })) as typeof deleteTeam

    registerTeamRunForSessionCleanup("team-run-a")
    registerTeamRunForSessionCleanup("team-run-b")

    // when
    const report = await cleanupSessionTeamRuns({
      config,
      tmuxMgr,
      bgMgr,
      deps: {
        deleteTeam: deleteTeamMock,
        log: mock(() => {}),
      },
    })

    // then
    expect(deleteTeamMock).toHaveBeenCalledTimes(2)
    expect(deleteTeamMock).toHaveBeenNthCalledWith(1, "team-run-a", config, tmuxMgr, bgMgr, { force: true, worktreeCleanup: "preserve" })
    expect(deleteTeamMock).toHaveBeenNthCalledWith(2, "team-run-b", config, tmuxMgr, bgMgr, { force: true, worktreeCleanup: "preserve" })
    expect(report).toEqual({
      cleanedTeamRunIds: ["team-run-a", "team-run-b"],
      removedLayoutTeamRunIds: ["team-run-a", "team-run-b"],
      keptWorktrees: [],
      errors: [],
    })
    expect(getSessionCreatedTeamRunIds()).toEqual([])
  })
})
