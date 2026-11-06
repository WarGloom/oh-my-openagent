import { afterEach, expect, test } from "bun:test"
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { TmuxConfigSchema } from "../../../config/schema/tmux"
import { TmuxSessionManager } from "../../tmux-subagent/manager"
import { createRemovalTestContext } from "./remove-member.test-support"
import { finishTeamMemberRemoval } from "./remove-member"
import { transitionRuntimeState } from "../team-state-store/store"
import { deleteTeam } from "./delete-team"

const { fixture, cleanup } = createRemovalTestContext()
afterEach(cleanup)

for (const shared of [false, true])
  test(`reports archived legacy worktrees without deleting their work with shared worktree=${shared}`, async () => {
    // given
    const input = await fixture()
    const directory = input.config.base_dir ?? ""
    const worktree = path.join(directory, "worker-worktree")
    const pane = path.join(directory, "pane-4")
    await mkdir(worktree)
    await writeFile(path.join(worktree, "kept"), "partial work")
    await writeFile(pane, "preserved pane")
    await transitionRuntimeState(
      input.teamRunId,
      (state) => ({
        ...state,
        members: state.members.map((member) =>
          member.name === "worker"
            ? { ...member, worktreePath: worktree, tmuxPaneId: "%4" }
            : { ...member, worktreePath: shared ? worktree : undefined },
        ),
        tmuxLayout: { ownedSession: false, targetSessionId: "test" },
      }),
      input.config,
    )
    await finishTeamMemberRemoval({
      ...input,
      client: { session: { abort: async () => true } },
      bgMgr: { findBySession: () => undefined, getTask: () => undefined, cancelTask: async () => true },
    })
    expect(await readFile(path.join(worktree, "kept"), "utf8")).toBe("partial work")
    expect(await readFile(pane, "utf8")).toBe("preserved pane")
    const client = createOpencodeClient()
    const ctx = {
      client,
      project: { id: "test", worktree: directory, time: { created: 1, updated: 1 } },
      directory,
      worktree: directory,
      experimental_workspace: { register: () => {} },
      serverUrl: new URL("http://127.0.0.1:1"),
      $: Bun.$,
    }
    const manager = new TmuxSessionManager(ctx, TmuxConfigSchema.parse({ enabled: false }), {
      getCurrentPaneId: () => undefined,
      log: () => {},
    })
    const cleanedPanes: string[] = []
    try {
      // when
      const result = await deleteTeam(
        input.teamRunId,
        { ...input.config, tmux_visualization: true },
        manager,
        undefined,
        undefined,
        {
          canVisualize: () => true,
          removeTeamLayout: async (_id, layout) => {
            const paneIds = layout && "paneIds" in layout ? (layout.paneIds ?? []) : []
            for (const paneId of paneIds) {
              cleanedPanes.push(paneId)
              if (paneId === "%4") await rm(pane)
            }
          },
          log: () => {},
        },
      )
      // then
      expect(result.removedWorktrees).toEqual([])
      expect(result.keptWorktrees?.map((entry) => entry.member).sort()).toEqual(
        shared ? ["lead", "worker"] : ["worker"],
      )
      expect(
        result.keptWorktrees?.every((entry) => entry.reason === "legacy-directory" && entry.directory === worktree),
      ).toBe(true)
      expect(cleanedPanes).toEqual(["%4"])
      expect(await readFile(path.join(worktree, "kept"), "utf8")).toBe("partial work")
      await expect(access(pane)).rejects.toThrow()
    } finally {
      await manager.cleanup()
    }
  })
