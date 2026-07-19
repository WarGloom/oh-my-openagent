import { z } from "zod"

import { MIRROR_SCHEMA_VERSION } from "./constants"
import type { AgentStatus, LoopLive, TeamMemberStatus, TeamRow } from "./state-types"

const AGENT_STATUS_VALUES = [
  "busy",
  "idle",
  "error",
  "running",
  "retry",
] as const satisfies readonly AgentStatus[]

const AgentRowSchema = z.object({
  name: z.string(),
  status: z.enum(AGENT_STATUS_VALUES),
})

const TEAM_MEMBER_STATUS_VALUES = [
  "pending",
  "running",
  "idle",
  "errored",
  "completed",
  "shutdown_approved",
] as const satisfies readonly TeamMemberStatus[]

const TeamMemberRowSchema = z.object({
  name: z.string(),
  status: z.enum(TEAM_MEMBER_STATUS_VALUES),
  work: z.string().nullable(),
  sessionId: z.string().min(1).nullable(),
})

const TeamRowSchema = z.object({
  name: z.string(),
  leadSessionId: z.string().min(1).nullable().default(null),
  members: z.array(TeamMemberRowSchema),
})

const LoopLiveSchema = z.object({
  kind: z.literal("live"),
  goalsDone: z.number().int().nonnegative(),
  goalsTotal: z.number().int().nonnegative(),
  pass: z.number().int().nonnegative(),
  fail: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  activeGoal: z.string().nullable(),
}) satisfies z.ZodType<LoopLive>

export const TuiRuntimeSnapshotSchema = z.object({
  version: z.literal(MIRROR_SCHEMA_VERSION),
  projectDir: z.string(),
  updatedAt: z.number(),
  activeAgents: z.array(AgentRowSchema),
  loop: LoopLiveSchema.nullable(),
  teams: z.array(TeamRowSchema).default([]),
})

export type TuiRuntimeSnapshot = Omit<z.infer<typeof TuiRuntimeSnapshotSchema>, "teams"> & {
  readonly teams: readonly TeamRow[]
}

export function parseSnapshot(raw: unknown): TuiRuntimeSnapshot | null {
  const parsed = TuiRuntimeSnapshotSchema.safeParse(raw)
  if (!parsed.success) {
    return null
  }
  return parsed.data
}
