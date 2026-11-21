import { z } from "zod"
import { DEFAULT_JEV_ARTIFACT_ID } from "../../shared/jev-artifact-metadata"

export const JEV_CATEGORY_LADDER_MAX = 12

export const JevRoutingConfigSchema = z
  .object({
    mode: z.enum(["off", "observe", "active"]).default("off"),
    artifact_id: z.string().trim().min(1).default(DEFAULT_JEV_ARTIFACT_ID),
    model: z.string().trim().min(1).default("jev-latest"),
    api_key_env: z.string().trim().min(1).default("TYPESAFE_API_KEY"),
    timeout_ms: z.number().int().min(100).max(5000).default(2000),
    min_suitability: z.number().min(0).max(1).default(0.6),
    ladder: z.array(z.string().trim().min(1)).min(2).max(JEV_CATEGORY_LADDER_MAX).optional(),
    default: z.string().trim().min(1).optional(),
    named_agent_tiers: z
      .record(
        z.string(),
        z
          .object({
            role: z.string().trim().min(1).max(300),
            lighter: z.string().regex(/^[^\s/#]+\/[^\s#]+$/),
            stronger: z.string().regex(/^[^\s/#]+\/[^\s#]+$/),
          })
          .strict()
          .refine((tiers) => tiers.lighter !== tiers.stronger, "The two tiers must specify distinct model IDs"),
      )
      .optional(),
    agent_ladders: z
      .record(
        z.string(),
        z
          .object({
            ladder: z.array(z.string()),
            default: z.string().trim().min(1),
            suitability: z.record(z.string(), z.string()).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()

export type JevRoutingConfig = z.infer<typeof JevRoutingConfigSchema>
