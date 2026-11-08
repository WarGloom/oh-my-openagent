import { z } from "zod"
import type { BackgroundTask } from "../features/background-agent/types"

const status = z.enum(["pending", "running", "completed", "error", "cancelled", "interrupt"])
const date = z.coerce.date().optional()
const mention = z.object({ start: z.number(), end: z.number(), text: z.string() })
const skillSelection = z.object({ id: z.string(), arguments: z.string().optional(), mention: mention.optional() })
const settings = {
  variant: z.string().optional(),
  reasoning: z.string().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  maxTokens: z.number().optional(),
  thinking: z.object({ type: z.enum(["enabled", "disabled"]), budgetTokens: z.number().optional() }).optional(),
}

export const backgroundTaskRecord = z.object({
  id: z.string(),
  sessionId: z.string().optional(),
  parentSessionId: z.string(),
  parentMessageId: z.string(),
  description: z.string(),
  prompt: z.string(),
  agent: z.string(),
  status,
  rootSessionId: z.string().optional(),
  teamRunId: z.string().optional(),
  spawnDepth: z.number().optional(),
  originalPrompt: z.string().optional(),
  skillContent: z.string().optional(),
  category: z.string().optional(),
  cwd: z.string().optional(),
  parentAgent: z.string().optional(),
  parentModel: z.object({ providerID: z.string(), modelID: z.string() }).optional(),
  parentTools: z.record(z.string(), z.boolean()).optional(),
  model: z
    .object({
      ...settings,
      providerID: z.string(),
      modelID: z.string(),
      reasoningEffort: z.string().optional(),
      tools: z.record(z.string(), z.boolean()).optional(),
    })
    .optional(),
  fallbackChain: z
    .array(
      z.object({
        ...settings,
        providers: z.array(z.string()),
        model: z.string(),
        reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
      }),
    )
    .optional(),
  attemptCount: z.number().optional(),
  currentAttemptID: z.string().optional(),
  attempts: z
    .array(
      z.object({
        attemptId: z.string(),
        attemptNumber: z.number(),
        status,
        sessionId: z.string().optional(),
        providerId: z.string().optional(),
        modelId: z.string().optional(),
        variant: z.string().optional(),
        error: z.string().optional(),
        startedAt: date,
        completedAt: date,
      }),
    )
    .optional(),
  sessionPermission: z
    .array(z.object({ permission: z.string(), pattern: z.string(), action: z.enum(["allow", "deny"]) }))
    .optional(),
  userPermission: z.record(z.string(), z.enum(["ask", "allow", "deny"])).optional(),
  isUnstableAgent: z.boolean().optional(),
  concurrencyGroup: z.string().optional(),
  queuedAt: date,
  startedAt: date,
  completedAt: date,
  result: z.string().optional(),
  error: z.string().optional(),
  deliveredNoticeID: z.string().optional(),
  recoveryPrompt: z.string().optional(),
  nativeAdmissionID: z.string().optional(),
  nativePromptID: z.string().optional(),
  nativeProvisioningAdmissionID: z.string().optional(),
  nativeSkillActivationIDs: z.array(z.string()).optional(),
  nativeSkillSelections: z.array(skillSelection).optional(),
  nativeAcceptedSkillsAdmissionID: z.string().optional(),
  nativeRun: z.object({ childSessionID: z.string(), generation: z.string() }).optional(),
  nativeInvocation: z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("tool"),
        agent: z.string(),
        messageID: z.string(),
        toolCallID: z.string(),
        team: z.object({ teamRunID: z.string(), member: z.string() }).optional(),
      }),
      z.object({ kind: z.literal("command"), agent: z.string(), invocationID: z.string(), command: z.string() }),
      z.object({
        kind: z.literal("team"),
        agent: z.string(),
        invocationID: z.string(),
        teamRunID: z.string(),
        member: z.string(),
        provisioningAdmissionID: z.string(),
      }),
    ])
    .optional(),
  nativeCompletion: z.enum(["parent", "none"]).optional(),
  nativeMode: z.enum(["foreground", "background"]).optional(),
  nativeInheritedPermit: z.boolean().optional(),
  nativeContinued: z.boolean().optional(),
  nativePrompt: z
    .object({
      text: z.string(),
      files: z
        .array(
          z.object({
            uri: z.string(),
            name: z.string().optional(),
            description: z.string().optional(),
            mention: mention.optional(),
            source: z
              .discriminatedUnion("type", [
                z.object({ type: z.literal("inline") }),
                z.object({ type: z.literal("uri"), uri: z.string() }),
              ])
              .optional(),
          }),
        )
        .optional(),
      agents: z.array(z.object({ name: z.string(), mention: mention.optional() })).optional(),
      skills: z.array(skillSelection).optional(),
    })
    .optional(),
  nativeMetadata: z.record(z.string(), z.json()).optional(),
  nativeTaskKey: z.string().optional(),
  skills: z.array(z.string()).optional(),
  progress: z
    .object({ toolCalls: z.number(), lastTool: z.string().optional(), lastUpdate: z.coerce.date() })
    .optional(),
})

export function encodeBackgroundTask(
  task: BackgroundTask & { readonly deliveredNoticeID?: string; readonly recoveryPrompt?: string },
) {
  return z.json().parse(JSON.parse(JSON.stringify(backgroundTaskRecord.parse(task))))
}
