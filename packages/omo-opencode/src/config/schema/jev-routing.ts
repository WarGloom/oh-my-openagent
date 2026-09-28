import { z } from "zod"

export const JevRoutingConfigSchema = z.object({
  mode: z.enum(["off", "observe", "active"]).default("off"),
  timeout_ms: z.number().int().min(100).max(5000).default(2000),
  min_suitability: z.number().min(0).max(1).default(0.6),
  ladder: z.array(z.string().trim().min(1)).min(2).max(8),
  default: z.string().trim().min(1),
}).strict()

export type JevRoutingConfig = z.infer<typeof JevRoutingConfigSchema>
