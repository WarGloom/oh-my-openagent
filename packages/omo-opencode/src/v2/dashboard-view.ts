import type { Plugin } from "@opencode/plugin/tui"
import { TextRenderable, type BoxRenderable, type KeyEvent, type MouseEvent } from "@opentui/core"
import { box, text, type ViewNode } from "../features/tui-sidebar/element-helpers"
import { assertNever } from "../features/tui-sidebar/state-types"
import type { DashboardSnapshot } from "./dashboard-channel"
import { dashboardLabel } from "./dashboard-label"
export { dashboardLabel } from "./dashboard-label"

export type DashboardData = Pick<DashboardSnapshot, "tasks" | "monitors" | "teams">
export type DashboardTheme = Pick<Plugin.Context["theme"], "text" | "background">
export type DashboardViewState =
  | { readonly kind: "ready"; readonly snapshot: DashboardData }
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "error"; readonly message: string }
export type DashboardNavigation = {
  readonly onOpenFullView: () => void
  readonly onNavigateSession: (sessionID: string) => void
}
type DashboardStatus =
  | DashboardData["tasks"]["rows"][number]["status"]
  | DashboardData["monitors"]["rows"][number]["status"]
  | DashboardData["teams"][number]["status"]
  | DashboardData["teams"][number]["members"][number]["status"]
  | DashboardSnapshot["activity"]["agents"][number]["status"]

export function dashboardStatusColor(status: DashboardStatus, theme: DashboardTheme) {
  const tones = {
    pending: "warning",
    running: "info",
    completed: "success",
    error: "error",
    cancelled: "muted",
    interrupt: "warning",
    starting: "info",
    exited: "muted",
    stopped: "muted",
    failed: "error",
    creating: "info",
    active: "info",
    shutdown_requested: "warning",
    deleting: "warning",
    deleted: "muted",
    orphaned: "warning",
    idle: "muted",
    errored: "error",
    shutdown_approved: "muted",
    busy: "info",
    retry: "warning",
  } as const satisfies Record<DashboardStatus, "warning" | "info" | "success" | "error" | "muted">
  const tone = tones[status]
  return tone === "muted" ? theme.text.muted : theme.text.feedback[tone].base
}

export function buildDashboardActivityNodes(
  activity: DashboardSnapshot["activity"],
  theme: DashboardTheme,
): ViewNode[] {
  const loop = activity.loop
  return [
    ...(activity.agents.length === 0
      ? []
      : [
          box({ flexDirection: "column" }, [
            text({ fg: theme.text.base, attributes: 1 }, "Agents"),
            ...activity.agents.map((agent) =>
              text(
                { fg: dashboardStatusColor(agent.status, theme), wrapMode: "word" },
                `${agent.status} / ${dashboardLabel(agent.name)}`,
              ),
            ),
          ]),
        ]),
    ...(loop === null
      ? []
      : [
          box({ flexDirection: "column" }, [
            text({ fg: theme.text.base, attributes: 1 }, "ULW"),
            text({ fg: theme.text.base }, `goals ${loop.goalsDone}/${loop.goalsTotal}`),
            text({ fg: theme.text.feedback.success.base }, `pass ${loop.pass}`),
            text({ fg: loop.fail ? theme.text.feedback.error.base : theme.text.muted }, `fail ${loop.fail}`),
            text({ fg: theme.text.muted }, `pending ${loop.pending} blocked ${loop.blocked}`),
            text({ fg: theme.text.muted }, "active private"),
          ]),
        ]),
  ]
}

export function dashboardAction(
  action: {
    readonly label: string
    readonly run: () => void
    readonly primary?: boolean
    readonly compact?: boolean
  },
  theme: DashboardTheme,
): ViewNode {
  const variant = action.primary ? "primary" : "secondary"
  const paint = (node: BoxRenderable, state: "base" | "hovered" | "focused" | "pressed") => {
    node.backgroundColor = theme.background.action[variant][state]
    for (const child of node.getChildren())
      if (child instanceof TextRenderable) child.fg = theme.text.action[variant][state]
  }
  return box(
    {
      flexDirection: "column",
      width: "100%",
      flexShrink: 0,
      focusable: true,
      backgroundColor: theme.background.action[variant].base,
      "on:focused": function (this: BoxRenderable) {
        paint(this, "focused")
      },
      "on:blurred": function (this: BoxRenderable) {
        paint(this, "base")
      },
      onMouseOver: function (this: BoxRenderable) {
        paint(this, this.focused ? "focused" : "hovered")
      },
      onMouseOut: function (this: BoxRenderable) {
        paint(this, this.focused ? "focused" : "base")
      },
      onMouseDown: function (this: BoxRenderable, event: MouseEvent) {
        event.stopPropagation()
        this.focus()
        paint(this, "pressed")
      },
      onMouseUp: function (this: BoxRenderable, event: MouseEvent) {
        event.stopPropagation()
        paint(this, "focused")
        action.run()
      },
      onKeyDown: (event: KeyEvent) => {
        if (event.name !== "return" && event.name !== "space") return
        event.preventDefault()
        event.stopPropagation()
        action.run()
      },
    },
    [
      text(
        {
          fg: theme.text.action[variant].base,
          truncate: action.compact === true,
          wrapMode: action.compact ? "none" : "word",
        },
        dashboardLabel(action.label),
      ),
    ],
  )
}

export function dashboardStateNodes(state: DashboardViewState | null, theme: DashboardTheme): ViewNode[] {
  if (state === null) return [text({ fg: theme.text.muted }, "Dashboard unavailable for this session.")]
  switch (state.kind) {
    case "ready":
      return []
    case "loading":
      return [text({ fg: theme.text.muted }, "Loading dashboard...")]
    case "unavailable":
      return [text({ fg: theme.text.muted }, "Dashboard unavailable for this session.")]
    case "error":
      return [
        text(
          { fg: theme.text.feedback.error.base, wrapMode: "word" },
          `Could not load dashboard: ${dashboardLabel(state.message)}. Reopen the dashboard to retry.`,
        ),
      ]
    default:
      return assertNever(state)
  }
}

export function buildDashboardSidebarNodes(
  state: DashboardViewState | null,
  theme: DashboardTheme,
  navigation: DashboardNavigation,
): ViewNode[] {
  const header = dashboardAction({ label: "Open dashboard", primary: true, run: navigation.onOpenFullView }, theme)
  if (state === null || state.kind !== "ready") return [header, ...dashboardStateNodes(state, theme)]
  const { tasks, monitors, teams } = state.snapshot
  const activeTasks = tasks.rows
    .filter((row) => row.status === "running" || row.status === "pending")
    .toSorted((a, b) => Number(b.status === "running") - Number(a.status === "running"))
  const activeMonitors = monitors.rows.filter((row) => row.status === "running" || row.status === "starting")
  return [
    box({ flexDirection: "column", width: "100%", gap: 1 }, [
      header,
      box({ flexDirection: "column" }, [
        text({ fg: theme.text.base }, `Tasks: ${tasks.counts.running} running, ${tasks.counts.pending} pending`),
        text(
          { fg: tasks.counts.error ? theme.text.feedback.error.base : theme.text.muted },
          `History: ${tasks.counts.completed} completed, ${tasks.counts.error} error, ${tasks.counts.cancelled} cancelled, ${tasks.counts.interrupt} interrupted`,
        ),
        ...activeTasks.slice(0, 4).flatMap((row) => {
          const sessionID = row.sessionId
          return [
            text({ fg: dashboardStatusColor(row.status, theme) }, `${row.status} / ${dashboardLabel(row.agent)}`),
            ...(sessionID
              ? [
                  dashboardAction(
                    { label: row.description, compact: true, run: () => navigation.onNavigateSession(sessionID) },
                    theme,
                  ),
                ]
              : [text({ fg: theme.text.base, truncate: true, wrapMode: "none" }, dashboardLabel(row.description))]),
          ]
        }),
        ...(activeTasks.length > 4
          ? [text({ fg: theme.text.muted }, `${activeTasks.length - 4} more in full view`)]
          : []),
      ]),
      box({ flexDirection: "column" }, [
        text(
          { fg: theme.text.base },
          `Monitors: ${monitors.counts.running} running, ${monitors.counts.starting} starting`,
        ),
        text(
          { fg: monitors.counts.failed ? theme.text.feedback.error.base : theme.text.muted },
          `History: ${monitors.counts.exited} exited, ${monitors.counts.stopped} stopped, ${monitors.counts.failed} failed`,
        ),
        ...activeMonitors
          .slice(0, 3)
          .flatMap((row) => [
            text({ fg: dashboardStatusColor(row.status, theme) }, row.status),
            text({ fg: theme.text.base, truncate: true, wrapMode: "none" }, dashboardLabel(row.label)),
          ]),
        ...(activeMonitors.length > 3
          ? [text({ fg: theme.text.muted }, `${activeMonitors.length - 3} more in full view`)]
          : []),
      ]),
      box({ flexDirection: "column" }, [
        text({ fg: theme.text.base }, `Teams: ${teams.length}`),
        ...teams
          .slice(0, 3)
          .flatMap((team) => [
            text(
              { fg: dashboardStatusColor(team.status, theme) },
              `${team.status.replaceAll("_", " ")} / ${team.members.length} members`,
            ),
            text({ fg: theme.text.base, truncate: true, wrapMode: "none" }, dashboardLabel(team.teamName)),
          ]),
        ...(teams.length > 3 ? [text({ fg: theme.text.muted }, `${teams.length - 3} more in full view`)] : []),
      ]),
      ...(tasks.rows.length + monitors.rows.length + teams.length === 0
        ? [text({ fg: theme.text.muted }, "No work in this session. Start a task to see it here.")]
        : []),
    ]),
  ]
}
