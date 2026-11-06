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

/** Content for a host-owned scrollbox or dialog; the host also owns Escape and focus traversal. */
export function buildDashboardFullViewNodes(
  state: DashboardViewState | null,
  theme: DashboardTheme,
  navigation: Pick<DashboardNavigation, "onNavigateSession">,
): ViewNode[] {
  const title = text({ fg: theme.text.base, attributes: 1 }, "Dashboard")
  if (state === null || state.kind !== "ready") return [title, ...dashboardStateNodes(state, theme)]
  const { tasks, monitors, teams } = state.snapshot
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
          return box({ flexDirection: "column", flexShrink: 0 }, [
            text(
              { fg: dashboardStatusColor(row.status, theme), wrapMode: "word" },
              `${row.status === "interrupt" ? "interrupted" : row.status} / ${dashboardLabel(row.agent)}`,
            ),
            ...(sessionID
              ? [dashboardAction({ label: row.description, run: () => navigation.onNavigateSession(sessionID) }, theme)]
              : [text({ fg: theme.text.base, wrapMode: "word" }, dashboardLabel(row.description))]),
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
