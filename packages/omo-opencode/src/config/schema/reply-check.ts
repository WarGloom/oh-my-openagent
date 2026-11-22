import { z } from "zod"

const pattern = z
  .string()
  .min(1)
  .max(512)
  .refine((source) => {
    try {
      return !new RegExp(source, "iu").test("")
    } catch (error) {
      if (error instanceof SyntaxError) return false
      throw error
    }
  }, "Expected a valid, nonempty regular expression")

const rule = z.object({ name: z.string().min(1), citation: z.string().min(1), rule_text: z.string().min(1) })
const question = rule.extend({ question: z.string().min(1) })

export const ReplyCheckConfigSchema = z.object({
  patterns: z
    .array(rule.extend({ pattern, ignore: z.array(pattern).max(16).default([]) }))
    .max(32)
    .default([]),
  phrases: z
    .array(rule.extend({ phrases: z.array(z.string().min(1)).min(1).max(32) }))
    .max(32)
    .default([]),
  jev: z.object({ progress_only: question, missing_decision_options: question }).optional(),
})

export type ReplyCheckConfig = z.infer<typeof ReplyCheckConfigSchema>
