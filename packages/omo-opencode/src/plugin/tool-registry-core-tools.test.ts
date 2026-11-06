import { describe, expect, mock, test } from "bun:test"
import { tool } from "@opencode-ai/plugin"
import type { SkillLoadOptions } from "../tools/skill/types"
import type { ToolRegistryFactories } from "./tool-registry-factories"

import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import { createCoreTools } from "./tool-registry-core-tools"
import { createFakePluginContext } from "../v2/fake-plugin-context"
import { createPluginInput } from "../v2/create-plugin-input"
import { createSessionTracker } from "../v2/session-tracker"
import { createTeamModeToolsRecord } from "./tool-registry-team-tools"
import { OhMyOpenCodeConfigSchema } from "../config"

const fakeTool = tool({
  description: "fake tool",
  args: {},
  async execute(): Promise<string> {
    return "ok"
  },
})

test("gate repair: the V2 model loader detaches maps from subsequent publications", () => {
  // given
  const pluginConfig = OhMyOpenCodeConfigSchema.parse({
    agents: { "sisyphus-junior": { model: "test/first" } },
    categories: { quick: { model: "test/first" } },
  })
  const factory = mock((_options: Parameters<ToolRegistryFactories["createDelegateTask"]>[0]) => fakeTool)
  createCoreTools({
    ctx: createPluginInput(createFakePluginContext().context, { tracker: createSessionTracker(), warn: () => {} }),
    pluginConfig,
    managers: unsafeTestValue({
      backgroundManager: {},
      tmuxSessionManager: {},
      skillMcpManager: {},
      modelFallbackControllerAccessor: {},
    }),
    skillContext: { mergedSkills: [], availableSkills: [], browserProvider: "playwright", disabledSkills: new Set() },
    availableCategories: [],
    factories: { ...createFactories(() => fakeTool), createDelegateTask: factory },
  })
  const snapshot = factory.mock.calls[0]?.[0].loadCurrentModelConfig?.()
  if (!pluginConfig.agents || !pluginConfig.categories) throw new Error("Fixture models missing")
  // when
  pluginConfig.agents["sisyphus-junior"] = { model: "test/second" }
  pluginConfig.categories.quick = { model: "test/second" }
  // then
  expect(snapshot?.agents?.["sisyphus-junior"]?.model).toBe("test/first")
  expect(snapshot?.categories?.quick?.model).toBe("test/first")
})

test.each(["create", "add"])("gate repair: team %s derives the junior model from the current config", (kind) => {
  // given
  const pluginConfig = OhMyOpenCodeConfigSchema.parse({
    team_mode: { enabled: true },
    agents: { "sisyphus-junior": { model: "test/first" } },
  })
  const create = mock((..._args: Parameters<ToolRegistryFactories["createTeamCreateTool"]>) => fakeTool)
  const add = mock((..._args: Parameters<ToolRegistryFactories["createTeamAddMemberTool"]>) => fakeTool)
  createTeamModeToolsRecord({
    pluginConfig,
    ctx: unsafeTestValue({ client: {} }),
    managers: unsafeTestValue({ backgroundManager: {} }),
    factories: {
      ...createFactories(() => fakeTool),
      createTeamCreateTool: create,
      createTeamAddMemberTool: add,
      createTeamRemoveMemberTool: () => fakeTool,
    },
  })
  // when
  if (!pluginConfig.agents) throw new Error("Fixture agents missing")
  pluginConfig.agents["sisyphus-junior"] = { model: "test/second" }
  // then
  expect((kind === "create" ? create.mock.calls[0]?.[4] : add.mock.calls[0]?.[3])?.sisyphusJuniorModel).toBe(
    "test/second",
  )
})

function createFactories(createSkillTool: (options: SkillLoadOptions) => typeof fakeTool): ToolRegistryFactories {
  return {
    createBackgroundTools: () => ({}),
    createCallOmoAgent: () => fakeTool,
    createLookAt: () => fakeTool,
    createMonitorTools: () => ({}),
    createSkillMcpTool: () => fakeTool,
    createSkillTool,
    createGrepTools: () => ({}),
    createGlobTools: () => ({}),
    createSessionManagerTools: () => ({}),
    createDelegateTask: () => fakeTool,
    discoverCommandsSync: () => [],
    interactive_bash: fakeTool,
    createTaskCreateTool: () => fakeTool,
    createTaskGetTool: () => fakeTool,
    createTaskList: () => fakeTool,
    createTaskUpdateTool: () => fakeTool,
    createHashlineEditTool: () => fakeTool,
    createTeamApproveShutdownTool: () => fakeTool,
    createTeamCreateTool: () => fakeTool,
    createTeamDeleteTool: () => fakeTool,
    createTeamRejectShutdownTool: () => fakeTool,
    createTeamShutdownRequestTool: () => fakeTool,
    createTeamSendMessageTool: () => fakeTool,
    createTeamTaskCreateTool: () => fakeTool,
    createTeamTaskGetTool: () => fakeTool,
    createTeamTaskListTool: () => fakeTool,
    createTeamTaskUpdateTool: () => fakeTool,
    createTeamStatusTool: () => fakeTool,
    createTeamListTool: () => fakeTool,
  }
}

describe("#given disabled native skills in the registry skill context", () => {
  test("#when core tools register the skill tool #then disabled skills are passed to the skill tool factory", () => {
    // given
    const disabledSkills = new Set(["native-security-skill"])
    const createSkillTool = mock((options: SkillLoadOptions) => fakeTool)

    // when
    createCoreTools({
      ctx: unsafeTestValue({ directory: "/tmp/project" }),
      pluginConfig: unsafeTestValue({
        disabled_agents: ["multimodal-looker"],
      }),
      managers: unsafeTestValue({
        backgroundManager: {},
        tmuxSessionManager: {},
        skillMcpManager: {},
        modelFallbackControllerAccessor: {},
      }),
      skillContext: {
        mergedSkills: [],
        availableSkills: [],
        browserProvider: "playwright",
        disabledSkills,
      },
      availableCategories: [],
      factories: createFactories(createSkillTool),
    })

    // then
    expect(createSkillTool).toHaveBeenCalledTimes(1)
    expect(createSkillTool.mock.calls[0]?.[0].disabledSkills).toBe(disabledSkills)
  })
})

describe("#given core skill tools are registered", () => {
  test.each([
    { agents: false, expected: false },
    { agents: undefined, expected: true },
    { agents: true, expected: true },
  ])(
    "#when claude_code.agents is $agents #then task receives the flag and shares the runtime skill resolver",
    ({ agents, expected }) => {
      const createSkillTool = mock((options: SkillLoadOptions) => fakeTool)
      const createDelegateTask = mock((options: Parameters<ToolRegistryFactories["createDelegateTask"]>[0]) => fakeTool)
      const createSkillMcpTool = mock((options: Parameters<ToolRegistryFactories["createSkillMcpTool"]>[0]) => fakeTool)
      const factories = {
        ...createFactories(createSkillTool),
        createDelegateTask,
        createSkillMcpTool,
      }

      createCoreTools({
        ctx: unsafeTestValue({
          directory: "/tmp/project",
          client: {
            config: { get: async () => ({ data: {} }) },
          },
        }),
        pluginConfig: unsafeTestValue({
          disabled_agents: ["multimodal-looker"],
          claude_code: { agents },
        }),
        managers: unsafeTestValue({
          backgroundManager: {},
          tmuxSessionManager: {},
          skillMcpManager: {},
          modelFallbackControllerAccessor: {},
        }),
        skillContext: {
          mergedSkills: [],
          availableSkills: [],
          browserProvider: "playwright",
          disabledSkills: new Set(),
        },
        availableCategories: [],
        factories,
      })

      const skillResolver = createSkillTool.mock.calls[0]?.[0].getLoadedSkills

      expect(typeof skillResolver).toBe("function")
      expect(createDelegateTask.mock.calls[0]?.[0].getLoadedSkills).toBe(skillResolver)
      expect(createDelegateTask.mock.calls[0]?.[0].claudeCodeAgentsEnabled).toBe(expected)
      expect(createSkillMcpTool.mock.calls[0]?.[0].getLoadedSkills).toBe(skillResolver)
    },
  )

  test("#when a cleanup delay is configured #then delegate task receives it", () => {
    const createDelegateTask = mock((options: Parameters<ToolRegistryFactories["createDelegateTask"]>[0]) => fakeTool)
    const factories = {
      ...createFactories(() => fakeTool),
      createDelegateTask,
    }

    createCoreTools({
      ctx: unsafeTestValue({ directory: "/tmp/project", client: {} }),
      pluginConfig: unsafeTestValue({
        disabled_agents: ["multimodal-looker"],
        background_task: { taskCleanupDelayMs: 120000 },
      }),
      managers: unsafeTestValue({
        backgroundManager: {},
        tmuxSessionManager: {},
        skillMcpManager: {},
        modelFallbackControllerAccessor: {},
      }),
      skillContext: {
        mergedSkills: [],
        availableSkills: [],
        browserProvider: "playwright",
        disabledSkills: new Set(),
      },
      availableCategories: [],
      factories,
    })

    expect(createDelegateTask.mock.calls[0]?.[0].taskCleanupDelayMs).toBe(120000)
  })
})

describe("#given the plugin runs on OpenCode 2.x (a V2 plugin input)", () => {
  function registerTools(ctx: Parameters<typeof createCoreTools>[0]["ctx"]) {
    return createCoreTools({
      ctx,
      pluginConfig: unsafeTestValue({ disabled_agents: ["multimodal-looker"], goal: { enabled: true } }),
      managers: unsafeTestValue({
        backgroundManager: {},
        tmuxSessionManager: {},
        skillMcpManager: {},
        modelFallbackControllerAccessor: {},
      }),
      skillContext: { mergedSkills: [], availableSkills: [], browserProvider: "playwright", disabledSkills: new Set() },
      availableCategories: [],
      factories: {
        ...createFactories(() => fakeTool),
        createGrepTools: () => ({ grep: fakeTool }),
        createGlobTools: () => ({ glob: fakeTool }),
      },
    })
  }

  test("#when registering core tools #then grep, glob and goal tools are omitted so the host versions win", () => {
    // given / when
    const tools = registerTools(
      createPluginInput(createFakePluginContext().context, { tracker: createSessionTracker(), warn: () => {} }),
    )

    // then
    expect(tools.grep).toBeUndefined()
    expect(tools.glob).toBeUndefined()
    expect(tools.create_goal).toBeUndefined()
    expect(tools.skill).toBeUndefined()
    expect(tools.skill_mcp).toBeDefined()
  })

  test("#when the same tools register on V1 #then grep, glob and goal tools are present", () => {
    // given / when
    const tools = registerTools(unsafeTestValue({ directory: "/tmp/project", client: {} }))

    // then
    expect(tools.grep).toBeDefined()
    expect(tools.glob).toBeDefined()
    expect(tools.create_goal).toBeDefined()
    expect(tools.skill).toBeDefined()
    expect(tools.skill_mcp).toBeDefined()
  })
})
