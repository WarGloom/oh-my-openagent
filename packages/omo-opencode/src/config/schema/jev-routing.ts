import { z } from "zod"

export const JevRoutingConfigSchema = z
  .object({
    mode: z.enum(["off", "observe", "active"]).default("off"),
    model: z.string().trim().min(1).default("jev-latest"),
    api_key_env: z.string().trim().min(1).default("TYPESAFE_API_KEY"),
    timeout_ms: z.number().int().min(100).max(5000).default(2000),
    min_suitability: z.number().min(0).max(1).default(0.6),
    ladder: z.array(z.string().trim().min(1)).min(2).max(8).optional(),
    default: z.string().trim().min(1).optional(),
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
