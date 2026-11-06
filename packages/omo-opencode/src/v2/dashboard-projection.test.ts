import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TeamModeConfigSchema } from "@oh-my-opencode/team-core/config"
import { TeamSpecSchema } from "@oh-my-opencode/team-core/types"
import { createRuntimeState, saveRuntimeState } from "@oh-my-opencode/team-core/team-state-store"
import { createTask } from "@oh-my-opencode/team-core/team-tasklist"
import type { BackgroundTask } from "../features/background-agent/types"
import type { MonitorRecord } from "../features/monitor/types"
import { dashboardSnapshotSchema } from "./dashboard-channel"
import { projectDashboard } from "./dashboard-projection"

test("snapshot scopes direct children and team membership and excludes private owner fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "dashboard-projection-"))
  const config = TeamModeConfigSchema.parse({ enabled: true, base_dir: root })
  const task: BackgroundTask = {
    id: "task",
    parentSessionId: "lead",
    parentMessageId: "msg",
    sessionId: "child",
    agent: "explore",
    description: "inspect",
    prompt: "private prompt",
    result: "private result",
    error: "private error",
    status: "interrupt",
    startedAt: new Date(12),
    completedAt: new Date(34),
    progress: { toolCalls: 2, lastTool: "read", lastUpdate: new Date(34), lastMessage: "private message" },
  }
  const monitor: MonitorRecord = {
    id: "monitor",
    label: "checks",
    command: "private command",
    mode: "idle",
    parentSessionId: "lead",
    status: "failed",
    exitCode: 2,
    startedAt: new Date(0),
    counters: {
      totalLines: 0,
      matchedLines: 0,
      unmatchedLines: 0,
      droppedMatched: 0,
      droppedUnmatched: 0,
      bytesDropped: 0,
      lastSequence: 0,
    },
  }
  const spec = TeamSpecSchema.parse({
    name: "visible",
    leadAgentId: "worker",
    members: [{ name: "worker", kind: "subagent_type", subagent_type: "sisyphus" }],
  })
  try {
    const state = await createRuntimeState(spec, "lead", "project", config)
    await saveRuntimeState(
      {
        ...state,
        members: state.members.map((member) => ({
          ...member,
          sessionId: "member",
          status: "errored",
          worktreePath: "private path",
        })),
      },
      config,
    )
    await createRuntimeState({ ...spec, name: "outside" }, "outsider", "project", config)
    await createTask(
      state.teamRunId,
      { subject: "private subject", description: "private body", status: "claimed", blocks: [], blockedBy: [] },
      config,
    )
    const remembered = new Map<string, readonly string[]>()
    const owners = {
      backgroundManager: {
        getTasksByParentSession: (id: string) => (id === "lead" ? [task] : []),
        onVisibleChange: () => () => {},
      },
      monitorManager: { list: (id: string) => (id === "lead" ? [monitor] : []), onVisibleChange: () => () => {} },
      teamModeConfig: config,
    }
    const snapshot = await projectDashboard("lead", owners, (id, ids) => {
      remembered.set(id, ids)
    })
    expect(snapshot).toEqual({
      tasks: {
        counts: { pending: 0, running: 0, completed: 0, error: 0, cancelled: 0, interrupt: 1 },
        rows: [
          {
            id: "task",
            agent: "explore",
            description: "inspect",
            status: "interrupt",
            sessionId: "child",
            startedAt: 12,
            completedAt: 34,
            toolCalls: 2,
            lastTool: "read",
          },
        ],
      },
      monitors: {
        counts: { starting: 0, running: 0, exited: 0, stopped: 0, failed: 1 },
        rows: [{ id: "monitor", label: "checks", status: "failed", exitCode: 2 }],
      },
      teams: [
        {
          teamRunId: state.teamRunId,
          teamName: "visible",
          status: "creating",
          members: [{ name: "worker", status: "errored", sessionId: "member" }],
          tasks: { pending: 0, claimed: 1, in_progress: 0, completed: 0, deleted: 0 },
        },
      ],
    })
    dashboardSnapshotSchema.parse({ revision: 0, sessionID: "lead", ...snapshot, activity: { agents: [], loop: null } })
    expect(remembered.get(state.teamRunId)).toEqual(["lead", "member"])
    expect((await projectDashboard("member", owners, () => {})).teams.map((team) => team.teamName)).toEqual(["visible"])
    const child = await projectDashboard("child", owners, () => {})
    expect(child.tasks.rows).toEqual([])
    expect(child.teams).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
