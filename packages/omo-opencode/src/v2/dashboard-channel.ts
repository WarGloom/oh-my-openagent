import { z } from "zod"
import { AgentRowSchema, LoopLiveSchema } from "../features/tui-sidebar/snapshot-schema"

export const dashboardTaskStatus = z.enum(["pending", "running", "completed", "error", "cancelled", "interrupt"])
export const dashboardMonitorStatus = z.enum(["starting", "running", "exited", "stopped", "failed"])
export const dashboardTeamStatus = z.enum(["creating", "active", "shutdown_requested", "deleting", "deleted", "failed", "orphaned"])
export const dashboardMemberStatus = z.enum(["pending", "running", "idle", "errored", "completed", "shutdown_approved"])
export const dashboardTeamTaskStatus = z.enum(["pending", "claimed", "in_progress", "completed", "deleted"])
const count = z.number().int().nonnegative()
export const dashboardSnapshotSchema = z.object({
  revision: count,
  sessionID: z.string(),
  activity: z.object({ agents: z.array(AgentRowSchema), loop: LoopLiveSchema.extend({ activeGoal: z.null() }).nullable() }),
  tasks: z.object({
    counts: z.record(dashboardTaskStatus, count),
    rows: z.array(z.object({
      id: z.string(), agent: z.string(), description: z.string(), status: dashboardTaskStatus,
      sessionId: z.string().optional(), startedAt: z.number().optional(), completedAt: z.number().optional(),
      toolCalls: count.optional(), lastTool: z.string().optional(),
    })),
  }),
  monitors: z.object({
    counts: z.record(dashboardMonitorStatus, count),
    rows: z.array(z.object({ id: z.string(), label: z.string(), status: dashboardMonitorStatus, exitCode: z.number().int().optional() })),
  }),
  teams: z.array(z.object({
    teamRunId: z.string(), teamName: z.string(), status: dashboardTeamStatus,
    members: z.array(z.object({ name: z.string(), status: dashboardMemberStatus, sessionId: z.string().optional() })),
    tasks: z.record(dashboardTeamTaskStatus, count),
  })),
})
export const dashboardChangedSchema = z.object({ revision: count, sessionIDs: z.array(z.string()).optional() })
export const dashboardChannel = {
  id: "omo.dashboard",
  methods: { get: { input: z.object({ sessionID: z.string().min(1) }), output: dashboardSnapshotSchema.nullable() } },
  events: { changed: { schema: dashboardChangedSchema } },
} as const

export type DashboardSnapshot = z.infer<typeof dashboardSnapshotSchema>
export type DashboardChanged = z.infer<typeof dashboardChangedSchema>
