import { z } from "zod"

const JevCandidateSchema = z.object({
  model: z.string().regex(/^[^\s/]+\/[^\s/]+(?:\/[^\s/]+)*$/),
  suitability: z.string().trim().min(1).max(1000),
})

export const JevRoutingConfigSchema = z.object({
  mode: z.enum(["off", "observe", "active"]).default("off"),
  timeout_ms: z.number().int().min(100).max(5000).default(2000),
  min_suitability: z.number().min(0).max(1).default(0.9),
  categories: z.record(z.string(), z.array(JevCandidateSchema).min(2).max(8)).default({}),
})

export type JevRoutingConfig = z.infer<typeof JevRoutingConfigSchema>
