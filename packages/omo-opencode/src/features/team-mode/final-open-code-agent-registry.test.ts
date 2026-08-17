/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"

import type { FinalOpenCodeAgentRegistryClient } from "./final-open-code-agent-registry"

import { replaceProjectAgentProvenance, resolveFinalProjectAgent } from "./final-open-code-agent-registry"

const TEAM_TOOLS = ["team_send_message", "team_task_list", "team_task_get", "team_task_update", "team_status", "call_omo_agent"] as const

function createPermissionRules(taskAction: "allow" | "deny" = "deny") {
  return [...TEAM_TOOLS.map((permission) => ({ permission, pattern: "*", action: "allow" as const })), { permission: "task", pattern: "*", action: taskAction }, { permission: "question", pattern: "*", action: "deny" }]
}

describe("FinalOpenCodeAgentSchema", () => {
  test("tolerates null hidden, variant, and model from OpenCode output", async () => {
    // given: a registry entry shaped like OpenCode app.agents with null optional fields
    const directory = "/tmp/test-registry-null-fields"
    replaceProjectAgentProvenance(directory, ["opencode-agent"])

    // Shaped like a raw OpenCode app.agents payload, where unset optional fields
    // serialize as null rather than undefined.
    const registryEntry: Record<string, unknown> = {
      name: "opencode-agent",
      mode: "subagent",
      native: false,
      hidden: null,
      variant: null,
      model: { providerID: "openai", modelID: "gpt-5.4-mini" },
      permission: createPermissionRules(),
    }

    const mockClient: FinalOpenCodeAgentRegistryClient = {
      app: {
        agents: async () => [registryEntry],
      },
    }

    // when: resolveFinalProjectAgent is called
    const result = await resolveFinalProjectAgent(mockClient, directory, "opencode-agent")

    // then: it resolves without throwing and returns the agent with model defined
    expect(result.name).toBe("opencode-agent")
    expect(result.model).toEqual({ providerID: "openai", modelID: "gpt-5.4-mini" })
  })

  test("narrows final task allow to the member launch deny overlay", async () => {
    // given: a final project agent that unconditionally allows task
    const directory = "/tmp/test-registry-task-allow"
    replaceProjectAgentProvenance(directory, ["opencode-agent"])
    const mockClient: FinalOpenCodeAgentRegistryClient = {
      app: {
        agents: async () => [{
          name: "opencode-agent",
          mode: "all",
          native: false,
          hidden: false,
          permission: createPermissionRules("allow"),
        }],
      },
    }

    // when: the agent is resolved with the member launch permission overlay
    const result = await resolveFinalProjectAgent(mockClient, directory, "opencode-agent")

    // then: the enforcing task false overlay may narrow the final allow
    expect(result).toEqual({ name: "opencode-agent", model: undefined })
  })
})
