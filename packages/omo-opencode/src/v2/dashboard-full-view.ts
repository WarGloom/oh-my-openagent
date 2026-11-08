import { box, text, type ViewNode } from "../features/tui-sidebar/element-helpers"
import {
  dashboardAction,
  dashboardLabel,
  dashboardStateNodes,
  dashboardStatusColor,
  type DashboardNavigation,
  type DashboardTheme,
  type DashboardViewState,
} from "./dashboard-view"
import type { DashboardSnapshot } from "./dashboard-channel"

export type DashboardActions = {
  readonly onCancelTask?: (row: DashboardSnapshot["tasks"]["rows"][number]) => void
  readonly onRetryTask?: (row: DashboardSnapshot["tasks"]["rows"][number]) => void
  readonly onStopMonitor?: (row: DashboardSnapshot["monitors"]["rows"][number]) => void
}

/** Content for a host-owned scrollbox or dialog; the host also owns Escape and focus traversal. */
export function buildDashboardFullViewNodes(
  state: DashboardViewState | null,
  theme: DashboardTheme,
  navigation: Pick<DashboardNavigation, "onNavigateSession"> & DashboardActions,
  clock: { readonly now: number; readonly timeZone?: string } = { now: Date.now() },
): ViewNode[] {
  const title = text({ fg: theme.text.base, attributes: 1 }, "Dashboard")
  if (state === null || state.kind !== "ready") return [title, ...dashboardStateNodes(state, theme)]
  const { tasks, monitors, teams } = state.snapshot
  const date = new Intl.DateTimeFormat("sv-SE", {
    timeZone: clock.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: clock.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
  const today = date.format(clock.now)
  const timestamp = (value: number): string =>
    `${date.format(value) === today ? "" : `${date.format(value)} `}${time.format(value)}`
  return [
    box({ flexDirection: "column", width: "100%", gap: 1 }, [
      title,
      box({ flexDirection: "column", gap: 1 }, [
        text({ fg: theme.text.base, attributes: 1 }, "Tasks"),
        text(
          { fg: theme.text.base, wrapMode: "word" },
          `${tasks.counts.running} running, ${tasks.counts.pending} pending, ${tasks.counts.completed} completed`,
        ),
        text(
          { fg: tasks.counts.error ? theme.text.feedback.error.base : theme.text.muted, wrapMode: "word" },
          `${tasks.counts.error} error, ${tasks.counts.cancelled} cancelled, ${tasks.counts.interrupt} interrupted`,
        ),
        ...tasks.rows.map((row) => {
          const sessionID = row.sessionId
          const timing: string[] = []
          if (row.startedAt !== undefined) timing.push(`started ${timestamp(row.startedAt)}`)
          else if (row.queuedAt !== undefined) timing.push(`queued ${timestamp(row.queuedAt)}`)
          if (row.completedAt !== undefined) {
            const ended = `ended ${timestamp(row.completedAt)}`
            if (row.startedAt === undefined) timing.push(ended)
            else {
              const seconds = Math.floor(Math.max(0, row.completedAt - row.startedAt) / 1000)
              const minutes = Math.floor(seconds / 60)
              const duration =
                minutes >= 60
                  ? `${Math.floor(minutes / 60)}h${minutes % 60}m`
                  : minutes > 0
                    ? `${minutes}m${seconds % 60}s`
                    : `${seconds}s`
              timing.push(`${ended} (${duration})`)
            }
          }
          return box({ flexDirection: "column", flexShrink: 0 }, [
            text(
              { fg: dashboardStatusColor(row.status, theme), wrapMode: "word" },
              `${row.status === "interrupt" ? "interrupted" : row.status} / ${dashboardLabel(row.agent)}`,
            ),
            ...(timing.length === 0 ? [] : [text({ fg: theme.text.muted, wrapMode: "word" }, timing.join(" · "))]),
            ...(sessionID
              ? [dashboardAction({ label: row.description, run: () => navigation.onNavigateSession(sessionID) }, theme)]
              : [text({ fg: theme.text.base, wrapMode: "word" }, dashboardLabel(row.description))]),
            ...((row.status === "pending" || row.status === "running") && navigation.onCancelTask
              ? [dashboardAction({ label: "Cancel", run: () => navigation.onCancelTask?.(row) }, theme)]
              : []),
            ...((row.status === "error" || row.status === "cancelled" || row.status === "interrupt") &&
            !row.teamMember &&
            row.retryable !== false &&
            navigation.onRetryTask
              ? [dashboardAction({ label: "Retry", run: () => navigation.onRetryTask?.(row) }, theme)]
              : []),
            ...(row.error === undefined
              ? []
              : [text({ fg: theme.text.feedback.error.base, wrapMode: "word" }, dashboardLabel(row.error))]),
            ...(row.toolCalls !== undefined ? [text({ fg: theme.text.muted }, `${row.toolCalls} tool calls`)] : []),
            ...(row.lastTool !== undefined
              ? [text({ fg: theme.text.muted, wrapMode: "word" }, `Last tool: ${dashboardLabel(row.lastTool)}`)]
              : []),
          ])
        }),
        ...(tasks.rows.length === 0 ? [text({ fg: theme.text.muted }, "No tasks in this session.")] : []),
      ]),
      box({ flexDirection: "column", gap: 1 }, [
        text({ fg: theme.text.base, attributes: 1 }, "Monitors"),
        text(
          { fg: theme.text.base, wrapMode: "word" },
          `${monitors.counts.running} running, ${monitors.counts.starting} starting`,
        ),
        text(
          { fg: monitors.counts.failed ? theme.text.feedback.error.base : theme.text.muted, wrapMode: "word" },
          `${monitors.counts.exited} exited, ${monitors.counts.stopped} stopped, ${monitors.counts.failed} failed`,
        ),
        ...monitors.rows.map((row) =>
          box({ flexDirection: "column", flexShrink: 0 }, [
            text(
              { fg: dashboardStatusColor(row.status, theme) },
              `${row.status}${row.exitCode === undefined ? "" : ` / exit ${row.exitCode}`}`,
            ),
            text({ fg: theme.text.base, wrapMode: "word" }, dashboardLabel(row.label)),
            ...((row.status === "starting" || row.status === "running") && navigation.onStopMonitor
              ? [dashboardAction({ label: "Stop", run: () => navigation.onStopMonitor?.(row) }, theme)]
              : []),
          ]),
        ),
        ...(monitors.rows.length === 0 ? [text({ fg: theme.text.muted }, "No monitors in this session.")] : []),
      ]),
      box({ flexDirection: "column", gap: 1 }, [
        text({ fg: theme.text.base, attributes: 1 }, "Teams"),
        ...teams.map((team) =>
          box({ flexDirection: "column", flexShrink: 0 }, [
            text({ fg: theme.text.base, wrapMode: "word", attributes: 1 }, dashboardLabel(team.teamName)),
            text({ fg: dashboardStatusColor(team.status, theme) }, team.status.replaceAll("_", " ")),
            text(
              { fg: theme.text.muted, wrapMode: "word" },
              `Tasks: ${team.tasks.pending} pending, ${team.tasks.claimed} claimed, ${team.tasks.in_progress} in progress, ${team.tasks.completed} completed, ${team.tasks.deleted} deleted`,
            ),
            ...team.members.map((member) => {
              const sessionID = member.sessionId
              return box({ flexDirection: "column", flexShrink: 0 }, [
                text({ fg: dashboardStatusColor(member.status, theme) }, member.status.replaceAll("_", " ")),
                ...(sessionID
                  ? [dashboardAction({ label: member.name, run: () => navigation.onNavigateSession(sessionID) }, theme)]
                  : [text({ fg: theme.text.base, wrapMode: "word" }, dashboardLabel(member.name))]),
              ])
            }),
            ...(team.members.length === 0 ? [text({ fg: theme.text.muted }, "No members.")] : []),
          ]),
        ),
        ...(teams.length === 0 ? [text({ fg: theme.text.muted }, "No teams in this session.")] : []),
      ]),
    ]),
  ]
}
