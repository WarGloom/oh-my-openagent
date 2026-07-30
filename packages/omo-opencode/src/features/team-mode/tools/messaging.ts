import { randomUUID } from "node:crypto"

import { type ToolDefinition, tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

import type { TeamModeConfig } from "../../../config/schema/team-mode"
import { log } from "../../../shared/logger"
import { BroadcastNotPermittedError, sendMessage } from "@oh-my-opencode/team-core/team-mailbox/send"
import { MessageSchema } from "@oh-my-opencode/team-core/types"
import { deliverLive, type LiveDeliveryClient } from "./messaging-live-delivery"
import {
  defaultTeamSendMessageToolDeps,
  resolveTeamRuntimeDetails,
  shouldReserveRecipientMailbox,
  type TeamSendMessageToolDeps,
} from "./messaging-runtime"
import type { RuntimeState } from "@oh-my-opencode/team-core/types"

const MESSAGE_TOOL_KINDS = ["message", "announcement"] as const

export const TEAM_SEND_MESSAGE_CORRELATION_ID_DESCRIPTION = "Optional UUID correlation ID for linking to an existing team message thread. Omit this field unless you are copying an existing UUID; do not invent slugs or task IDs."

export type { LiveDeliveryClient } from "./messaging-live-delivery"
export type { TeamSendMessageToolDeps } from "./messaging-runtime"

const TeamReferenceArgsSchema = z.object({
  path: z.string().min(1),
  description: z.string().optional(),
})

const TeamSendMessageArgsSchema = z.object({
  teamRunId: z.string().min(1),
  to: z.string().min(1),
  body: z.string(),
  kind: z.enum(MESSAGE_TOOL_KINDS).optional(),
  correlationId: z.preprocess((value) => value === "" ? undefined : value, z.uuid().optional()),
  summary: z.string().optional(),
  references: z.array(TeamReferenceArgsSchema).optional(),
})

function resolveRecipientAlias(to: string, runtimeState: RuntimeState, senderName: string): string {
  if (to !== "lead") return to

  const leaderMember = runtimeState.members.find((member) => member.agentType === "leader")
  if (leaderMember === undefined || leaderMember.name === senderName) return to

  return leaderMember.name
}

export function createTeamSendMessageTool(
  config: TeamModeConfig,
  client: LiveDeliveryClient,
  deps: TeamSendMessageToolDeps = defaultTeamSendMessageToolDeps,
): ToolDefinition {
  return tool({
    description: "Send an async team message. Recipients receive it automatically as a future conversation turn; this tool returns delivery metadata, not replies or message history.",
    args: {
      teamRunId: tool.schema.string().describe("Team run ID"),
      to: tool.schema.string().describe("Recipient member name, or * for lead-only broadcast."),
      body: tool.schema.string().describe("Message body delivered into the recipient's conversation."),
      kind: tool.schema.enum(MESSAGE_TOOL_KINDS).optional().default("message").describe("Message kind"),
      correlationId: tool.schema.string().optional().describe(TEAM_SEND_MESSAGE_CORRELATION_ID_DESCRIPTION),
      summary: tool.schema.string().optional().describe("Optional brief summary for notifications/status surfaces."),
      references: tool.schema.array(tool.schema.object({
        path: tool.schema.string(),
        description: tool.schema.string().optional(),
      })).optional().describe("Optional references as [{ path, description? }]"),
    },
    execute: async (rawArgs, context) => {
      const args = TeamSendMessageArgsSchema.parse(rawArgs)
      const runtimeContext = context as { sessionID?: string; directory?: string }
      const sessionID = runtimeContext.sessionID

      if (!sessionID) {
        throw new Error("session ID is required")
      }

      const targetDirectory = typeof runtimeContext.directory === "string" ? runtimeContext.directory : process.cwd()

      const teamRuntime = await resolveTeamRuntimeDetails(args.teamRunId, sessionID, config, deps)
      const runtimeState = await deps.loadRuntimeState(teamRuntime.teamRunId, config)
      const resolvedRecipient = resolveRecipientAlias(args.to, runtimeState, teamRuntime.senderName)
      const message = MessageSchema.parse({
        version: 1,
        messageId: randomUUID(),
        from: teamRuntime.senderName,
        to: resolvedRecipient,
        body: args.body,
        kind: args.kind ?? "message",
        timestamp: Date.now(),
        correlationId: args.correlationId,
        summary: args.summary,
        references: args.references,
      })

      if (message.kind === "shutdown_request" || message.kind === "shutdown_approved" || message.kind === "shutdown_rejected") {
        throw new Error("must use lifecycle tools for shutdown kinds")
      }

      if (message.to === "*" && !teamRuntime.isLead) {
        throw new BroadcastNotPermittedError()
      }

      const reservedRecipients = new Set<string>(
        runtimeState.members
          .filter((member) => shouldReserveRecipientMailbox(member, message, teamRuntime.senderName))
          .map((member) => member.name),
      )

      const result = await sendMessage(message, teamRuntime.teamRunId, config, {
        isLead: teamRuntime.isLead,
        activeMembers: teamRuntime.activeMembers,
        reservedRecipients,
      })

      try {
        await deliverLive(client, message, teamRuntime.teamRunId, result.deliveredTo, config, targetDirectory, deps)
      } catch (liveError) {
        log("[team-mailbox] deliverLive top-level error (message already in inbox, safe to ignore)", {
          error: liveError instanceof Error ? liveError.message : String(liveError),
          teamRunId: teamRuntime.teamRunId,
          messageId: message.messageId,
        })
      }

      return JSON.stringify(result)
    },
  })
}
