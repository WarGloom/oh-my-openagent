import { expect, test } from "bun:test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { resolveSubagentAgentMatch } from "./subagent-agent-match"
import type { ExecutorContext } from "./executor-types"

test.each([false, true])("honors a registered agent deny before selection: disabled=%s", async (disabled) => {
  const context = unsafeTestValue<ExecutorContext>({
    directory: process.cwd(),
    claudeCodeAgentsEnabled: false,
    disabledAgents: disabled ? ["registered-specialist"] : [],
    client: { app: { agents: async () => ({ data: [{ name: "registered-specialist", mode: "subagent" }] }) } },
  })
  const result = await resolveSubagentAgentMatch("registered-specialist", context, {})
  expect(result).toMatchObject(
    disabled
      ? { kind: "error", result: { error: expect.stringMatching(/disabled/) } }
      : { kind: "matched", agentToUse: "registered-specialist" },
  )
})
