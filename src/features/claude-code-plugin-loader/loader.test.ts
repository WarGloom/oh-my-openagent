import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"
import type { PluginComponentsResult } from "./loader"
import * as actualDiscoveryModule from "./discovery"
import * as actualCommandLoaderModule from "./command-loader"
import * as actualSkillLoaderModule from "./skill-loader"
import * as actualAgentLoaderModule from "./agent-loader"
import * as actualMcpServerLoaderModule from "./mcp-server-loader"
import * as actualHookLoaderModule from "./hook-loader"

function createPluginComponentsResult(): PluginComponentsResult {
  return {
    commands: {
      "daplug:run-prompt": {
        name: "daplug:run-prompt",
        description: "Run prompt from daplug",
        template: "Execute daplug prompt flow.",
      },
      "daplug:templated": {
        name: "daplug:templated",
        description: "Templated prompt from daplug",
        template: "Echo $ARGUMENTS and ${user_message}.",
      },
    },
    skills: {
      "daplug:plugin-plan": {
        name: "daplug:plugin-plan",
        description: "Plan work from daplug skill",
        template: "Build a plan from plugin skill context.",
      },
    },
    agents: { "demo:agent": { description: "agent", mode: "subagent", prompt: "demo" } },
    mcpServers: { "demo:mcp": { type: "local", command: ["demo"] } },
    hooksConfigs: [{ hooks: {} }],
    plugins: [{ name: "daplug", version: "1.0.0", scope: "user", installPath: "/tmp/demo", pluginKey: "daplug@1.0.0" }],
    errors: [],
  }
}

async function importFreshLoaderModule() {
  return import(`./loader?plugin-loader-cache-test=${Date.now()}-${Math.random()}`)
}

function restoreActualPluginLoaderModules(): void {
  mock.module("./discovery", () => actualDiscoveryModule)
  mock.module("./command-loader", () => actualCommandLoaderModule)
  mock.module("./skill-loader", () => actualSkillLoaderModule)
  mock.module("./agent-loader", () => actualAgentLoaderModule)
  mock.module("./mcp-server-loader", () => actualMcpServerLoaderModule)
  mock.module("./hook-loader", () => actualHookLoaderModule)
}

describe("loadAllPluginComponents", () => {
  const originalEnv = { ...process.env }
  let loadAllPluginComponents: typeof import("./loader").loadAllPluginComponents
  let clearPluginComponentsCache: typeof import("./loader").clearPluginComponentsCache

  beforeEach(async () => {
    mock.restore()
    ;({ loadAllPluginComponents, clearPluginComponentsCache } = await importFreshLoaderModule())
    clearPluginComponentsCache()
    delete process.env.OPENCODE_DISABLE_CLAUDE_CODE
    delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_PLUGINS
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    mock.restore()
  })

  describe("when OPENCODE_DISABLE_CLAUDE_CODE is set to 'true'", () => {
    it("returns empty result without loading any plugins", async () => {
      // given
      process.env.OPENCODE_DISABLE_CLAUDE_CODE = "true"

      // when
      const result: PluginComponentsResult = await loadAllPluginComponents()

      // then
      expect(result.commands).toEqual({})
      expect(result.skills).toEqual({})
      expect(result.agents).toEqual({})
      expect(result.mcpServers).toEqual({})
      expect(result.hooksConfigs).toEqual([])
      expect(result.plugins).toEqual([])
      expect(result.errors).toEqual([])
    })
  })

  describe("when OPENCODE_DISABLE_CLAUDE_CODE is set to '1'", () => {
    it("returns empty result without loading any plugins", async () => {
      // given
      process.env.OPENCODE_DISABLE_CLAUDE_CODE = "1"

      // when
      const result: PluginComponentsResult = await loadAllPluginComponents()

      // then
      expect(result.commands).toEqual({})
      expect(result.plugins).toEqual([])
    })
  })

  describe("when OPENCODE_DISABLE_CLAUDE_CODE_PLUGINS is set to 'true'", () => {
    it("returns empty result without loading any plugins", async () => {
      // given
      process.env.OPENCODE_DISABLE_CLAUDE_CODE_PLUGINS = "true"

      // when
      const result: PluginComponentsResult = await loadAllPluginComponents()

      // then
      expect(result.commands).toEqual({})
      expect(result.plugins).toEqual([])
    })
  })

  describe("when OPENCODE_DISABLE_CLAUDE_CODE_PLUGINS is set to '1'", () => {
    it("returns empty result without loading any plugins", async () => {
      // given
      process.env.OPENCODE_DISABLE_CLAUDE_CODE_PLUGINS = "1"

      // when
      const result: PluginComponentsResult = await loadAllPluginComponents()

      // then
      expect(result.commands).toEqual({})
      expect(result.plugins).toEqual([])
    })
  })

  describe("when neither env var is set", () => {
    it("does not skip plugin loading", async () => {
      // given
      delete process.env.OPENCODE_DISABLE_CLAUDE_CODE
      delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_PLUGINS

      // when
      const result: PluginComponentsResult = await loadAllPluginComponents()

      // then — should attempt to load (may find 0 plugins, but shouldn't early-return)
      expect(result).toBeDefined()
      expect(result).toHaveProperty("commands")
      expect(result).toHaveProperty("plugins")
    })
  })

  describe("when env var is set to unrecognized value", () => {
    it("does not skip plugin loading", async () => {
      // given
      process.env.OPENCODE_DISABLE_CLAUDE_CODE = "yes"

      // when
      const result: PluginComponentsResult = await loadAllPluginComponents()

      // then — "yes" is not "true" or "1", should not skip
      expect(result).toBeDefined()
      expect(result).toHaveProperty("plugins")
    })
  })

  describe("when plugin loading repeats with the same options", () => {
    it("returns the cached result without reloading plugin dependencies", async () => {
      // given
      const result = createPluginComponentsResult()
      const discoverInstalledPlugins = mock(() => ({ plugins: result.plugins, errors: result.errors }))
      const loadPluginCommands = mock(() => result.commands)
      const loadPluginSkillsAsCommands = mock(() => result.skills)
      const loadPluginAgents = mock(() => result.agents)
      const loadPluginMcpServers = mock(async () => result.mcpServers)
      const loadPluginHooksConfigs = mock(() => result.hooksConfigs)

      mock.module("./discovery", () => ({ discoverInstalledPlugins }))
      mock.module("./command-loader", () => ({ loadPluginCommands }))
      mock.module("./skill-loader", () => ({ loadPluginSkillsAsCommands }))
      mock.module("./agent-loader", () => ({ loadPluginAgents }))
      mock.module("./mcp-server-loader", () => ({ loadPluginMcpServers }))
      mock.module("./hook-loader", () => ({ loadPluginHooksConfigs }))

      ;({ loadAllPluginComponents, clearPluginComponentsCache } = await importFreshLoaderModule())
      restoreActualPluginLoaderModules()
      mock.restore()

      clearPluginComponentsCache()
      const enabledPluginsOverride = { "demo@test": true }

      // when
      const firstResult = await loadAllPluginComponents({ enabledPluginsOverride })
      const secondResult = await loadAllPluginComponents({ enabledPluginsOverride })

      // then
      expect(firstResult).toEqual(result)
      expect(secondResult).toEqual(result)
      expect(discoverInstalledPlugins).toHaveBeenCalledTimes(1)
      expect(loadPluginCommands).toHaveBeenCalledTimes(1)
      expect(loadPluginSkillsAsCommands).toHaveBeenCalledTimes(1)
      expect(loadPluginAgents).toHaveBeenCalledTimes(1)
      expect(loadPluginMcpServers).toHaveBeenCalledTimes(1)
      expect(loadPluginHooksConfigs).toHaveBeenCalledTimes(1)
    })
  })

  describe("when the enabled plugin override changes", () => {
    it("reloads plugin components for the new cache key", async () => {
      // given
      const result = createPluginComponentsResult()
      const discoverInstalledPlugins = mock(() => ({ plugins: result.plugins, errors: result.errors }))
      const loadPluginCommands = mock(() => result.commands)
      const loadPluginSkillsAsCommands = mock(() => result.skills)
      const loadPluginAgents = mock(() => result.agents)
      const loadPluginMcpServers = mock(async () => result.mcpServers)
      const loadPluginHooksConfigs = mock(() => result.hooksConfigs)

      mock.module("./discovery", () => ({ discoverInstalledPlugins }))
      mock.module("./command-loader", () => ({ loadPluginCommands }))
      mock.module("./skill-loader", () => ({ loadPluginSkillsAsCommands }))
      mock.module("./agent-loader", () => ({ loadPluginAgents }))
      mock.module("./mcp-server-loader", () => ({ loadPluginMcpServers }))
      mock.module("./hook-loader", () => ({ loadPluginHooksConfigs }))

      ;({ loadAllPluginComponents, clearPluginComponentsCache } = await importFreshLoaderModule())
      restoreActualPluginLoaderModules()
      mock.restore()

      clearPluginComponentsCache()

      // when
      await loadAllPluginComponents({ enabledPluginsOverride: { "demo@test": true } })
      await loadAllPluginComponents({ enabledPluginsOverride: { "demo@test": false } })

      // then
      expect(discoverInstalledPlugins).toHaveBeenCalledTimes(2)
      expect(loadPluginCommands).toHaveBeenCalledTimes(2)
      expect(loadPluginSkillsAsCommands).toHaveBeenCalledTimes(2)
      expect(loadPluginAgents).toHaveBeenCalledTimes(2)
      expect(loadPluginMcpServers).toHaveBeenCalledTimes(2)
      expect(loadPluginHooksConfigs).toHaveBeenCalledTimes(2)
    })
  })

  describe("when the cache is cleared", () => {
    it("reloads plugin components on the next call", async () => {
      // given
      const result = createPluginComponentsResult()
      const discoverInstalledPlugins = mock(() => ({ plugins: result.plugins, errors: result.errors }))
      const loadPluginCommands = mock(() => result.commands)
      const loadPluginSkillsAsCommands = mock(() => result.skills)
      const loadPluginAgents = mock(() => result.agents)
      const loadPluginMcpServers = mock(async () => result.mcpServers)
      const loadPluginHooksConfigs = mock(() => result.hooksConfigs)

      mock.module("./discovery", () => ({ discoverInstalledPlugins }))
      mock.module("./command-loader", () => ({ loadPluginCommands }))
      mock.module("./skill-loader", () => ({ loadPluginSkillsAsCommands }))
      mock.module("./agent-loader", () => ({ loadPluginAgents }))
      mock.module("./mcp-server-loader", () => ({ loadPluginMcpServers }))
      mock.module("./hook-loader", () => ({ loadPluginHooksConfigs }))

      ;({ loadAllPluginComponents, clearPluginComponentsCache } = await importFreshLoaderModule())
      restoreActualPluginLoaderModules()
      mock.restore()

      clearPluginComponentsCache()

      // when
      await loadAllPluginComponents()
      clearPluginComponentsCache()
      await loadAllPluginComponents()

      // then
      expect(discoverInstalledPlugins).toHaveBeenCalledTimes(2)
      expect(loadPluginCommands).toHaveBeenCalledTimes(2)
      expect(loadPluginSkillsAsCommands).toHaveBeenCalledTimes(2)
      expect(loadPluginAgents).toHaveBeenCalledTimes(2)
      expect(loadPluginMcpServers).toHaveBeenCalledTimes(2)
      expect(loadPluginHooksConfigs).toHaveBeenCalledTimes(2)
    })
  })

  describe("when a caller mutates a cached result", () => {
    it("returns a fresh clone on the next cache hit", async () => {
      // given
      const result = createPluginComponentsResult()
      const discoverInstalledPlugins = mock(() => ({ plugins: result.plugins, errors: result.errors }))
      const loadPluginCommands = mock(() => result.commands)
      const loadPluginSkillsAsCommands = mock(() => result.skills)
      const loadPluginAgents = mock(() => result.agents)
      const loadPluginMcpServers = mock(async () => result.mcpServers)
      const loadPluginHooksConfigs = mock(() => result.hooksConfigs)

      mock.module("./discovery", () => ({ discoverInstalledPlugins }))
      mock.module("./command-loader", () => ({ loadPluginCommands }))
      mock.module("./skill-loader", () => ({ loadPluginSkillsAsCommands }))
      mock.module("./agent-loader", () => ({ loadPluginAgents }))
      mock.module("./mcp-server-loader", () => ({ loadPluginMcpServers }))
      mock.module("./hook-loader", () => ({ loadPluginHooksConfigs }))

      ;({ loadAllPluginComponents, clearPluginComponentsCache } = await importFreshLoaderModule())
      restoreActualPluginLoaderModules()
      mock.restore()

      clearPluginComponentsCache()

      // when
      const firstResult = await loadAllPluginComponents()
      firstResult.commands["daplug:run-prompt"]!.description = "mutated"
      const secondResult = await loadAllPluginComponents()

      // then
      expect(secondResult.commands["daplug:run-prompt"]!.description).toBe("Run prompt from daplug")
      expect(discoverInstalledPlugins).toHaveBeenCalledTimes(1)
    })
  })
})
