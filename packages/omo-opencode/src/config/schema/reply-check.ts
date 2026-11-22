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

export const WorkerReportCheckSchema = z.object({
  verdicts: z
    .array(z.string().min(1).max(64))
    .max(40)
    .default(["PASS", "FAIL", "INCONCLUSIVE", "APPROVE", "REJECT", "BLOCKED", "EXECUTED"]),
  units: z.array(z.string().min(1).max(64)).max(40).default(["tests", "passed", "failed", "jobs", "findings", "exit"]),
  attribution: pattern.default("\\b(?:worker|reviewer|subagent|agent|child|reported)\\b"),
  exact: rule,
  jev: z
    .object({
      summary: pattern.default("\\b(?:reported|reports|found|concluded|summarized|confirmed|delivered)\\b"),
      citation: z.string().min(1),
      rule_text: z.string().min(1),
      unsupported: z
        .string()
        .min(1)
        .max(1500)
        .default(
          "Does the reply state a result, verdict or cause for the worker's task that the report does not state?",
        ),
      omitted: z
        .string()
        .min(1)
        .max(1500)
        .default("Does the report state a failure, a blocker or an unmet condition that the reply does not mention?"),
    })
    .optional(),
})

export type WorkerReportCheck = z.infer<typeof WorkerReportCheckSchema>

export const ReplyCheckConfigSchema = z.object({
  max_jev_calls: z.number().int().min(1).max(32).default(8),
  patterns: z
    .array(rule.extend({ pattern, ignore: z.array(pattern).max(16).default([]) }))
    .max(32)
    .default([]),
  phrases: z
    .array(rule.extend({ phrases: z.array(z.string().min(1)).min(1).max(32) }))
    .max(32)
    .default([]),
  worker_reports: WorkerReportCheckSchema.optional(),
  jev: z.object({ progress_only: question, missing_decision_options: question }).optional(),
})

export type ReplyCheckConfig = z.infer<typeof ReplyCheckConfigSchema>
