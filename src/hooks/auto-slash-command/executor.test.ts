import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as actualDiscoveryModule from "../../features/claude-code-plugin-loader/discovery"
import * as actualCommandLoaderModule from "../../features/claude-code-plugin-loader/command-loader"
import * as actualSkillLoaderModule from "../../features/claude-code-plugin-loader/skill-loader"
import * as actualPluginLoaderIndexModule from "../../features/claude-code-plugin-loader/index"
import * as actualPluginCommandDiscoveryModule from "../../shared/plugin-command-discovery"
import * as actualSharedModule from "../../shared"
let executeSlashCommand: typeof import("./executor").executeSlashCommand

const ENV_KEYS = [
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PLUGINS_HOME",
  "CLAUDE_SETTINGS_PATH",
  "OPENCODE_CONFIG_DIR",
] as const

type EnvKey = (typeof ENV_KEYS)[number]
type EnvSnapshot = Record<EnvKey, string | undefined>

function createLoaderBuster(): string {
  return `${Date.now()}-${Math.random()}`
}

async function restorePluginLoaderModules(): Promise<void> {
  mock.module("../../features/claude-code-plugin-loader/discovery", () => actualDiscoveryModule)
  mock.module("../../features/claude-code-plugin-loader/command-loader", () => actualCommandLoaderModule)
  mock.module("../../features/claude-code-plugin-loader/command-loader.ts", () => actualCommandLoaderModule)
  mock.module("../../features/claude-code-plugin-loader/skill-loader", () => actualSkillLoaderModule)
  mock.module("../../features/claude-code-plugin-loader/skill-loader.ts", () => actualSkillLoaderModule)
  mock.module("../../features/claude-code-plugin-loader", () => actualPluginLoaderIndexModule)
  mock.module("../../features/claude-code-plugin-loader/index", () => actualPluginLoaderIndexModule)
  mock.module("../../features/claude-code-plugin-loader/index.ts", () => actualPluginLoaderIndexModule)
  mock.module("../../features/claude-code-plugin-loader/loader", () => actualPluginLoaderIndexModule)
  mock.module("../../features/claude-code-plugin-loader/loader.ts", () => actualPluginLoaderIndexModule)

  mock.module("../../shared/plugin-command-discovery", () => actualPluginCommandDiscoveryModule)
  mock.module("../../shared/plugin-command-discovery.ts", () => actualPluginCommandDiscoveryModule)
  mock.module("../../shared", () => actualSharedModule)
  mock.module("../../shared/index", () => actualSharedModule)
  mock.module("../../shared/index.ts", () => actualSharedModule)
}

async function importFreshExecutorModule() {
  return import(`./executor?auto-slash-executor-cache-fix=${createLoaderBuster()}`)
}

function writePluginFixture(baseDir: string): void {
  const claudeConfigDir = join(baseDir, "claude-config")
  const pluginsHome = join(claudeConfigDir, "plugins")
  const settingsPath = join(claudeConfigDir, "settings.json")
  const opencodeConfigDir = join(baseDir, "opencode-config")
  const pluginInstallPath = join(baseDir, "installed-plugins", "daplug")
  const pluginKey = "daplug@1.0.0"

  mkdirSync(join(pluginInstallPath, ".claude-plugin"), { recursive: true })
  mkdirSync(join(pluginInstallPath, "commands"), { recursive: true })

  writeFileSync(
    join(pluginInstallPath, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "daplug", version: "1.0.0" }, null, 2),
  )
  writeFileSync(
    join(pluginInstallPath, "commands", "run-prompt.md"),
    `---
description: Run prompt from daplug
---
Execute daplug prompt flow.
`,
  )
  writeFileSync(
    join(pluginInstallPath, "commands", "templated.md"),
    `---
description: Templated prompt from daplug
---
Echo $ARGUMENTS and \${user_message}.
`,
  )

  mkdirSync(pluginsHome, { recursive: true })
  writeFileSync(
    join(pluginsHome, "installed_plugins.json"),
    JSON.stringify(
      {
        version: 2,
        plugins: {
          [pluginKey]: [
            {
              scope: "user",
              installPath: pluginInstallPath,
              version: "1.0.0",
              installedAt: "2026-01-01T00:00:00.000Z",
              lastUpdated: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      },
      null,
      2,
    ),
  )

  mkdirSync(claudeConfigDir, { recursive: true })
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        enabledPlugins: {
          [pluginKey]: true,
        },
      },
      null,
      2,
    ),
  )
  mkdirSync(opencodeConfigDir, { recursive: true })

  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir
  process.env.CLAUDE_PLUGINS_HOME = pluginsHome
  process.env.CLAUDE_SETTINGS_PATH = settingsPath
  process.env.OPENCODE_CONFIG_DIR = opencodeConfigDir
}

describe("auto-slash command executor plugin dispatch", () => {
  let tempDir = ""
  let envSnapshot: EnvSnapshot

  beforeEach(async () => {
    mock.restore()
    await restorePluginLoaderModules()
    tempDir = mkdtempSync(join(tmpdir(), "omo-executor-plugin-test-"))
    envSnapshot = {
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      CLAUDE_PLUGINS_HOME: process.env.CLAUDE_PLUGINS_HOME,
      CLAUDE_SETTINGS_PATH: process.env.CLAUDE_SETTINGS_PATH,
      OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    }
    writePluginFixture(tempDir)
  })

  beforeEach(async () => {
    ({ executeSlashCommand } = await importFreshExecutorModule())
  })

  afterEach(() => {
    mock.restore()
    for (const key of ENV_KEYS) {
      const previousValue = envSnapshot[key]
      if (previousValue === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = previousValue
      }
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("resolves marketplace plugin commands when plugin loading is enabled", async () => {
    const result = await executeSlashCommand(
      {
        command: "daplug:run-prompt",
        args: "ship it",
        raw: "/daplug:run-prompt ship it",
      },
      {
        skills: [],
        pluginsEnabled: true,
      },
    )

    expect(result.success).toBe(true)
    expect(result.replacementText).toContain("# /daplug:run-prompt Command")
    expect(result.replacementText).toContain("**Scope**: plugin")
  })

  it("excludes marketplace commands when plugins are disabled via config toggle", async () => {
    const result = await executeSlashCommand(
      {
        command: "daplug:run-prompt",
        args: "",
        raw: "/daplug:run-prompt",
      },
      {
        skills: [],
        pluginsEnabled: false,
      },
    )

    expect(result.success).toBe(false)
    expect(result.error).toBe(
      'Command "/daplug:run-prompt" not found. Use the skill tool to list available skills and commands.',
    )
  })

  it("returns standard not-found for unknown namespaced commands", async () => {
    const result = await executeSlashCommand(
      {
        command: "daplug:missing",
        args: "",
        raw: "/daplug:missing",
      },
      {
        skills: [],
        pluginsEnabled: true,
      },
    )

    expect(result.success).toBe(false)
    expect(result.error).toBe(
      'Command "/daplug:missing" not found. Use the skill tool to list available skills and commands.',
    )
    expect(result.error).not.toContain("Marketplace plugin commands")
  })

  it("replaces $ARGUMENTS placeholders in plugin command templates", async () => {
    const result = await executeSlashCommand(
      {
        command: "daplug:templated",
        args: "ship it",
        raw: "/daplug:templated ship it",
      },
      {
        skills: [],
        pluginsEnabled: true,
      },
    )

    expect(result.success).toBe(true)
    expect(result.replacementText).toContain("Echo ship it and ship it.")
    expect(result.replacementText).not.toContain("$ARGUMENTS")
    expect(result.replacementText).not.toContain("${user_message}")
  })

  it("renders Atlas as the builtin start-work agent during slash-command execution", async () => {
    // given

    // when
    const result = await executeSlashCommand(
      {
        command: "start-work",
        args: "",
        raw: "/start-work",
      },
      {
        skills: [],
      },
    )

    // then
    expect(result.success).toBe(true)
    expect(result.replacementText).toContain("**Agent**: atlas")
  })
})
