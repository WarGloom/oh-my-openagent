import { listActiveTeams, loadRuntimeState } from "@oh-my-opencode/team-core/team-state-store"
import { listTasks } from "@oh-my-opencode/team-core/team-tasklist"
import type { TeamModeConfig } from "@oh-my-opencode/team-core/config"
import type { RuntimeState } from "@oh-my-opencode/team-core/types"
import type { BackgroundManager } from "../features/background-agent"
import type { MonitorManager } from "../features/monitor"
import type { DashboardSnapshot } from "./dashboard-channel"

export type DashboardOwners = {
  readonly backgroundManager: Pick<BackgroundManager, "getTasksByParentSession" | "onVisibleChange">
  readonly monitorManager?: Pick<MonitorManager, "list" | "onVisibleChange">
  readonly teamModeConfig?: TeamModeConfig
}

export function dashboardTeamSessions(state: RuntimeState): readonly string[] {
  return [
    ...new Set(
      [state.leadSessionId, ...state.members.map((member) => member.sessionId)].filter(
        (id): id is string => id !== undefined,
      ),
    ),
  ]
}

export async function loadDashboardTeam(teamRunId: string, config: TeamModeConfig): Promise<RuntimeState | null> {
  try {
    return await loadRuntimeState(teamRunId, config)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  }
}

export async function projectDashboard(
  sessionID: string,
  owners: DashboardOwners | undefined,
  remember: (teamRunId: string, sessionIDs: readonly string[]) => void,
): Promise<Pick<DashboardSnapshot, "tasks" | "monitors" | "teams">> {
  const tasks: DashboardSnapshot["tasks"] = {
    counts: { pending: 0, running: 0, completed: 0, error: 0, cancelled: 0, interrupt: 0 },
    rows: (owners?.backgroundManager.getTasksByParentSession(sessionID) ?? []).map((task) => ({
      id: task.id,
      agent: task.agent,
      description: task.description,
      status: task.status,
      ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }),
      ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt.getTime() }),
      ...(task.completedAt === undefined ? {} : { completedAt: task.completedAt.getTime() }),
      ...(task.progress === undefined ? {} : { toolCalls: task.progress.toolCalls }),
      ...(task.progress?.lastTool === undefined ? {} : { lastTool: task.progress.lastTool }),
    })),
  }
  for (const row of tasks.rows) tasks.counts[row.status] += 1
  const monitors: DashboardSnapshot["monitors"] = {
    counts: { starting: 0, running: 0, exited: 0, stopped: 0, failed: 0 },
    rows: (owners?.monitorManager?.list(sessionID) ?? []).map((monitor) => ({
      id: monitor.id,
      label: monitor.label,
      status: monitor.status,
      ...(monitor.exitCode === undefined ? {} : { exitCode: monitor.exitCode }),
    })),
  }
  for (const row of monitors.rows) monitors.counts[row.status] += 1
  const teams: DashboardSnapshot["teams"] = []
  const config = owners?.teamModeConfig
  if (config?.enabled) {
    for (const summary of await listActiveTeams(config)) {
      const state = await loadDashboardTeam(summary.teamRunId, config)
      if (state === null) continue
      const sessionIDs = dashboardTeamSessions(state)
      if (!sessionIDs.includes(sessionID)) continue
      remember(state.teamRunId, sessionIDs)
      const counts: DashboardSnapshot["teams"][number]["tasks"] = {
        pending: 0,
        claimed: 0,
        in_progress: 0,
        completed: 0,
        deleted: 0,
      }
      for (const task of await listTasks(state.teamRunId, config)) counts[task.status] += 1
      teams.push({
        teamRunId: state.teamRunId,
        teamName: state.teamName,
        status: state.status,
        tasks: counts,
        members: state.members.map((member) => ({
          name: member.name,
          status: member.status,
          ...(member.sessionId === undefined ? {} : { sessionId: member.sessionId }),
        })),
      })
    }
  }
  return { tasks, monitors, teams }
}
