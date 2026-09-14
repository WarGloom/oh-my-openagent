import { expect, test } from "bun:test"
import { TeamModeConfigSchema } from "./config"
import { TeamSpecSchema } from "./types"
import { normalizeTeamSpecInput } from "./team-registry/team-spec-input-normalizer"

test("roster configuration accepts 16, rejects 17, and preserves defaults and spawn fan-out", () => {
  expect(TeamModeConfigSchema.parse({ max_members: 16 }).max_members).toBe(16)
  expect(TeamModeConfigSchema.safeParse({ max_members: 17 }).success).toBe(false)
  expect(TeamModeConfigSchema.parse({})).toMatchObject({ max_members: 8, max_parallel_members: 4 })
  expect(TeamModeConfigSchema.parse({ max_parallel_members: 8 }).max_parallel_members).toBe(8)
  expect(TeamModeConfigSchema.safeParse({ max_parallel_members: 9 }).success).toBe(false)
})

test("normalized explicit lead plus 15 workers fits the roster, but a sixteenth worker does not", () => {
  const input = {
    name: "roster-boundary",
    lead: { name: "lead", subagent_type: "sisyphus" },
    members: Array.from({ length: 15 }, (_, index) => ({ name: `worker-${index}`, subagent_type: "sisyphus" })),
  }
  const spec = TeamSpecSchema.parse(normalizeTeamSpecInput(input))
  expect(spec.members).toHaveLength(16)
  expect(spec.leadAgentId).toBe("lead")
  input.members.push({ name: "overflow", subagent_type: "sisyphus" })
  expect(TeamSpecSchema.safeParse(normalizeTeamSpecInput(input)).success).toBe(false)
})
