import { describe, expect, test } from "bun:test"
import { buildContinuationPrompt, buildResumePrompt } from "./prompt"
import type { Goal } from "./types"

function createGoal(objective: string, usage?: { timeUsedSeconds: number; tokensUsed: number }): Goal {
  return {
    id: "goal-1",
    sessionID: "ses-1",
    objective,
    status: "active",
    tokensUsed: usage?.tokensUsed ?? 100,
    timeUsedSeconds: usage?.timeUsedSeconds ?? 60,
    createdAt: 1,
    updatedAt: 2,
  }
}

describe("buildContinuationPrompt", () => {
  test("omits the stored objective and usage but preserves the recovery tool cue", () => {
    const usage = { timeUsedSeconds: 7349, tokensUsed: 982451 }
    const prompt = buildContinuationPrompt(createGoal("continuation-objective-sentinel", usage))

    expect(prompt).not.toContain("continuation-objective-sentinel")
    expect(prompt).not.toContain(String(usage.timeUsedSeconds))
    expect(prompt).not.toContain(String(usage.tokensUsed))
    expect(prompt).toContain("get_goal")
    expect(prompt.length).toBeLessThan(400)
  })
})

describe("buildResumePrompt", () => {
  test("retains the escaped objective in the one-time resume prompt", () => {
    const objective = "resume-objective-<sentinel>&payload>"
    const goal = createGoal(objective)
    const extractObjectivePayload = (prompt: string): string | undefined =>
      prompt.match(/<untrusted_objective>\n([\s\S]*?)\n<\/untrusted_objective>/)?.[1]

    const resumePayload = extractObjectivePayload(buildResumePrompt({ ...goal, status: "paused" }))

    expect(resumePayload).toBe("resume-objective-&lt;sentinel&gt;&amp;payload&gt;")
    expect(resumePayload).not.toBe(objective)
  })
})
