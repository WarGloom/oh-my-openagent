import { afterEach, describe, expect, test } from "bun:test"

import { createSystemTransformHandler } from "./system-transform"
import { clearSessionTools, setSessionTools } from "../shared/session-tools-store"
import { ROUTINE_VERIFICATION_ROUTING_POLICY } from "../shared/routine-verification-routing-policy"
import { createSisyphusAgent } from "../agents/sisyphus-agent-factory"
import { applyToolConfig } from "../plugin-handlers/tool-config-handler"
import { clearSisyphusRuntimePromptContext, setSisyphusRuntimePromptContext } from "../agents/sisyphus-runtime-prompt-reconciler"

function createHandler(messagesImpl?: () => Promise<unknown>) {
  return createSystemTransformHandler({
    ctx: {
      client: {
        session: {
          messages: messagesImpl ?? (async () => ({ data: [] })),
        },
      },
    } as never,
  })
}

describe("createSystemTransformHandler", () => {
  afterEach(() => {
    clearSessionTools()
    clearSisyphusRuntimePromptContext()
  })

  test.each([true, false])("scopes verification routing to session task capability %s", async (task) => {
    // given
    setSessionTools("ses_policy_scope", { task, call_omo_agent: true })
    const output = { system: [ROUTINE_VERIFICATION_ROUTING_POLICY] }

    // when
    await createHandler()({ sessionID: "ses_policy_scope", model: { id: "gpt-6.1-sol", providerID: "openai" } }, output)

    // then
    expect(output.system.join("\n").includes("<Routine_Verification_Routing_Policy>")).toBe(task)
  })

  test.each(["allow", "deny", "disabled"] as const)("scopes orchestrator policy after %s task configuration and runtime rebuild", async (capability) => {
    // given
    const agent = createSisyphusAgent("anthropic/claude-sonnet-5", [], [], [], [
      { name: "quick", description: "QA fixture" },
      { name: "deep-low", description: "QA fixture" },
    ])
    agent.permission = { ...agent.permission, task: capability === "deny" ? "deny" : "allow" }
    const bakedPrompt = agent.prompt ?? ""
    const rebuiltPrompt = createSisyphusAgent("openai/gpt-6.1-sol", [], [], [], [
      { name: "quick", description: "QA fixture" },
      { name: "deep-low", description: "QA fixture" },
    ]).prompt ?? ""
    setSisyphusRuntimePromptContext({
      configuredModel: "anthropic/claude-sonnet-5", bakedPrompt,
      rebuildPromptForModel: () => `<Runtime_Rebuild_Receipt>${rebuiltPrompt}`,
    })

    // when
    applyToolConfig({ config: {}, pluginConfig: { disabled_tools: capability === "disabled" ? ["task"] : [] }, agentResult: { sisyphus: agent } })
    const output = { system: [agent.prompt ?? ""] }
    await createHandler()({ sessionID: "ses_orchestrator_scope", model: { id: "gpt-6.1-sol", providerID: "openai" } }, output)

    // then
    expect(output.system[0]).toContain("<Runtime_Rebuild_Receipt>")
    expect(output.system[0].includes("<Routine_Verification_Routing_Policy>")).toBe(capability === "allow")
  })

  test.each([
    { agentTask: "deny", sessionTask: true, modelSwitch: false },
    { agentTask: "deny", sessionTask: true, modelSwitch: true },
    { agentTask: "allow", sessionTask: false, modelSwitch: false },
    { agentTask: "allow", sessionTask: false, modelSwitch: true },
  ] as const)("respects session task overrides %j", async ({ agentTask, sessionTask, modelSwitch }) => {
    // given
    const categories = [{ name: "quick", description: "QA fixture" }, { name: "deep-low", description: "QA fixture" }]
    const agent = createSisyphusAgent("anthropic/claude-sonnet-5", [], [], [], categories)
    agent.permission = { ...agent.permission, task: agentTask }
    const rebuiltPrompt = createSisyphusAgent("openai/gpt-6.1-sol", [], [], [], categories).prompt ?? ""
    setSisyphusRuntimePromptContext({
      configuredModel: "anthropic/claude-sonnet-5", bakedPrompt: agent.prompt ?? "",
      rebuildPromptForModel: () => `<Runtime_Rebuild_Receipt>${rebuiltPrompt}`,
    })
    applyToolConfig({ config: {}, pluginConfig: {}, agentResult: { sisyphus: agent } })
    setSessionTools("ses_policy_override", { task: sessionTask, call_omo_agent: true })
    const output = { system: [agent.prompt ?? "", ROUTINE_VERIFICATION_ROUTING_POLICY] }

    // when
    await createHandler()({ sessionID: "ses_policy_override", model: modelSwitch
      ? { id: "gpt-6.1-sol", providerID: "openai" }
      : { id: "claude-sonnet-5", providerID: "anthropic" } }, output)

    // then
    expect(output.system[0].includes("<Runtime_Rebuild_Receipt>")).toBe(modelSwitch)
    expect(output.system[0].includes("<Routine_Verification_Routing_Policy>")).toBe(sessionTask)
    expect(output.system[1].includes("<Routine_Verification_Routing_Policy>")).toBe(sessionTask)
    expect(output.system.join("\n")).not.toContain("<Routine_Verification_Capability")
  })

  test("appends Serena navigation prompt when session has Serena tools", async () => {
    setSessionTools("ses_serena", {
      serena_find_file: true,
      grep: true,
    })

    const handler = createHandler()
    const output = { system: ["Base system prompt"] }

    await handler(
      {
        sessionID: "ses_serena",
        model: { id: "gpt-5.4", providerID: "openai" },
      },
      output,
    )

    expect(output.system).toHaveLength(2)
    expect(output.system[1]).toContain("<serena_navigation>")
  })

  test("does not append Serena navigation prompt when session lacks Serena tools", async () => {
    setSessionTools("ses_no_serena", {
      grep: true,
      read: true,
    })

    const handler = createHandler()
    const output = { system: ["Base system prompt"] }

    await handler(
      {
        sessionID: "ses_no_serena",
        model: { id: "gpt-5.4", providerID: "openai" },
      },
      output,
    )

    expect(output.system).toEqual(["Base system prompt"])
  })

  test("does not duplicate Serena navigation prompt", async () => {
    setSessionTools("ses_serena", {
      serena_find_file: true,
    })

    const handler = createHandler()
    const output = { system: ["Base system prompt", "<serena_navigation>existing</serena_navigation>"] }

    await handler(
      {
        sessionID: "ses_serena",
        model: { id: "gpt-5.4", providerID: "openai" },
      },
      output,
    )

    expect(output.system).toHaveLength(2)
  })

  test("loads session tools from session messages when cache is empty", async () => {
    const handler = createHandler(async () => ({
      data: [
        {
          info: {
            tools: {
              serena_find_file: true,
              grep: true,
            },
          },
        },
      ],
    }))
    const output = { system: ["Base system prompt"] }

    await handler(
      {
        sessionID: "ses_from_messages",
        model: { id: "gpt-5.4", providerID: "openai" },
      },
      output,
    )

    expect(output.system).toHaveLength(2)
    expect(output.system[1]).toContain("<serena_navigation>")
  })

  test("does not duplicate existing literal ultrawork prompt", async () => {
    const handler = createSystemTransformHandler(
      { ultrawork: true },
      () => "<ultrawork-mode>new</ultrawork-mode>",
    )
    const output = { system: ["Base system prompt", "<ultrawork-mode>existing</ultrawork-mode>"] }

    await handler(
      {
        sessionID: "ses_ultrawork",
        model: { id: "gpt-5.4", providerID: "openai" },
      },
      output,
    )

    expect(output.system).toEqual([
      "Base system prompt",
      "<ultrawork-mode>existing</ultrawork-mode>",
    ])
  })
})
