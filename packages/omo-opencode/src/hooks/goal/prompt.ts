import type { Goal } from "./types"

export function buildContinuationPrompt(_goal: Goal): string {
  return [
    "Continue working toward the active thread goal.",
    "If you need the objective or current status, call get_goal.",
    'Verify the outcome before calling update_goal with status "complete"; otherwise continue the next concrete action.',
  ].join("\n")
}

export function buildResumePrompt(goal: Goal): string {
  return [
    "A paused goal is being resumed.",
    "",
    "<untrusted_objective>",
    escapeXmlText(goal.objective),
    "</untrusted_objective>",
    "",
    "Continue working toward this objective. Do not repeat work already done.",
  ].join("\n")
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}
