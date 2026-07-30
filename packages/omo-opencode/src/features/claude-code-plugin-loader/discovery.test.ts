import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const originalClaudePluginsHome = process.env.CLAUDE_PLUGINS_HOME
const temporaryDirectories: string[] = []
const originalCwd = process.cwd()

function createTemporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function writeDatabase(pluginsHome: string, database: unknown): void {
  writeFileSync(join(pluginsHome, "installed_plugins.json"), JSON.stringify(database), "utf-8")
}

function createInstallPath(prefix: string): string {
  return createTemporaryDirectory(prefix)
}

async function discover(
  pluginsHome: string,
  suffix: string,
  options: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<(typeof import("./discovery"))["discoverInstalledPlugins"]>>> {
  const { discoverInstalledPlugins } = await import(`./discovery?t=${Date.now()}-${suffix}`)
  return discoverInstalledPlugins({
    pluginsHomeOverride: pluginsHome,
    loadPluginManifestOverride: () => null,
    ...options,
  })
}

describe("discoverInstalledPlugins", () => {
  beforeEach(() => {
    mock.module("../../shared/logger", () => ({
      log: () => {},
    }))

    process.env.CLAUDE_PLUGINS_HOME = createTemporaryDirectory("omo-claude-plugins-")
  })

  afterEach(() => {
    mock.restore()

    if (originalClaudePluginsHome === undefined) {
      delete process.env.CLAUDE_PLUGINS_HOME
    } else {
      process.env.CLAUDE_PLUGINS_HOME = originalClaudePluginsHome
    }

    if (process.cwd() !== originalCwd) {
      process.chdir(originalCwd)
    }

    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("preserves scoped package names from npm plugin keys", async () => {
    const pluginsHome = process.env.CLAUDE_PLUGINS_HOME as string
    const installPathBase = createTemporaryDirectory("omo-scoped-plugin-")
    const installPath = join(installPathBase, "@myorg", "my-plugin")
    mkdirSync(installPath, { recursive: true })

    writeDatabase(pluginsHome, {
      version: 2,
      plugins: {
        "@myorg/my-plugin@1.0.0": [
          {
            scope: "user",
            installPath,
            version: "1.0.0",
            installedAt: "2026-03-25T00:00:00Z",
            lastUpdated: "2026-03-25T00:00:00Z",
          },
        ],
      },
    })

    const discovered = await discover(pluginsHome, "scoped")

    expect(discovered.errors).toHaveLength(0)
    expect(discovered.plugins).toHaveLength(1)
    expect(discovered.plugins[0]?.name).toBe("@myorg/my-plugin")
  })

  it("derives package names from file URL plugin keys", async () => {
    const pluginsHome = process.env.CLAUDE_PLUGINS_HOME as string
    const installPath = createInstallPath("omo-fileurl-plugin-")

    writeDatabase(pluginsHome, {
      version: 2,
      plugins: {
        "file:///D:/configs/user-configs/.config/opencode/node_modules/oh-my-opencode@latest": [
          {
            scope: "user",
            installPath,
            version: "3.10.0",
            installedAt: "2026-03-20T00:00:00Z",
            lastUpdated: "2026-03-20T00:00:00Z",
          },
        ],
      },
    })

    const discovered = await discover(pluginsHome, "file-url")

    expect(discovered.errors).toHaveLength(0)
    expect(discovered.plugins).toHaveLength(1)
    expect(discovered.plugins[0]?.name).toBe("oh-my-opencode")
  })

  it("derives canonical package names from npm plugin keys", async () => {
    const pluginsHome = process.env.CLAUDE_PLUGINS_HOME as string
    const installPath = createInstallPath("omo-npm-plugin-")

    writeDatabase(pluginsHome, {
      version: 2,
      plugins: {
        "oh-my-openagent@3.13.1": [
          {
            scope: "user",
            installPath,
            version: "3.13.1",
            installedAt: "2026-03-26T00:00:00Z",
            lastUpdated: "2026-03-26T00:00:00Z",
          },
        ],
      },
    })

    const discovered = await discover(pluginsHome, "npm-name")

    expect(discovered.errors).toHaveLength(0)
    expect(discovered.plugins).toHaveLength(1)
    expect(discovered.plugins[0]?.name).toBe("oh-my-openagent")
  })

  describe("project-scoped entries in v1 format", () => {
    it("loads a plugin when cwd matches projectPath", async () => {
      const pluginsHome = process.env.CLAUDE_PLUGINS_HOME as string
      const projectDirectory = createTemporaryDirectory("omo-v1-project-match-")
      const installPath = createInstallPath("omo-v1-install-")

      writeDatabase(pluginsHome, {
        version: 1,
        plugins: {
          "project-plugin@market": {
            scope: "project",
            projectPath: projectDirectory,
            installPath,
            version: "1.0.0",
            installedAt: "2026-03-25T00:00:00Z",
            lastUpdated: "2026-03-25T00:00:00Z",
          },
        },
      })
      process.chdir(projectDirectory)

      const discovered = await discover(pluginsHome, "v1-match")

      expect(discovered.errors).toHaveLength(0)
      expect(discovered.plugins).toHaveLength(1)
      expect(discovered.plugins[0]?.name).toBe("project-plugin")
    })

    it("loads a plugin when cwd is a subdirectory of projectPath", async () => {
      const pluginsHome = process.env.CLAUDE_PLUGINS_HOME as string
      const projectDirectory = createTemporaryDirectory("omo-v1-project-sub-")
      const subdirectory = join(projectDirectory, "packages", "app")
      mkdirSync(subdirectory, { recursive: true })
      const installPath = createInstallPath("omo-v1-install-")

      writeDatabase(pluginsHome, {
        version: 1,
        plugins: {
          "sub-plugin@market": {
            scope: "project",
            projectPath: projectDirectory,
            installPath,
            version: "1.0.0",
            installedAt: "2026-03-25T00:00:00Z",
            lastUpdated: "2026-03-25T00:00:00Z",
          },
        },
      })
      process.chdir(subdirectory)

      const discovered = await discover(pluginsHome, "v1-subdirectory")

      expect(discovered.errors).toHaveLength(0)
      expect(discovered.plugins).toHaveLength(1)
      expect(discovered.plugins[0]?.name).toBe("sub-plugin")
    })

    it("skips a plugin when cwd does not match projectPath", async () => {
      const pluginsHome = process.env.CLAUDE_PLUGINS_HOME as string
      const projectDirectory = createTemporaryDirectory("omo-v1-project-miss-")
      const otherDirectory = createTemporaryDirectory("omo-v1-other-")
      const installPath = createInstallPath("omo-v1-install-")

      writeDatabase(pluginsHome, {
        version: 1,
        plugins: {
          "outside-plugin@market": {
            scope: "project",
            projectPath: projectDirectory,
            installPath,
            version: "1.0.0",
            installedAt: "2026-03-25T00:00:00Z",
            lastUpdated: "2026-03-25T00:00:00Z",
          },
        },
      })
      process.chdir(otherDirectory)

      const discovered = await discover(pluginsHome, "v1-mismatch")

      expect(discovered.errors).toHaveLength(0)
      expect(discovered.plugins).toHaveLength(0)
    })

    it("skips a project-scoped plugin when projectPath is missing", async () => {
      const pluginsHome = process.env.CLAUDE_PLUGINS_HOME as string
      const installPath = createInstallPath("omo-v1-install-")

      writeDatabase(pluginsHome, {
        version: 1,
        plugins: {
          "no-path-plugin@market": {
            scope: "project",
            installPath,
            version: "1.0.0",
            installedAt: "2026-03-25T00:00:00Z",
            lastUpdated: "2026-03-25T00:00:00Z",
          },
        },
      })

      const discovered = await discover(pluginsHome, "v1-missing-project-path")

      expect(discovered.errors).toHaveLength(0)
      expect(discovered.plugins).toHaveLength(0)
    })

    it("loads user-scoped plugins regardless of cwd", async () => {
      const pluginsHome = process.env.CLAUDE_PLUGINS_HOME as string
      const unrelatedDirectory = createTemporaryDirectory("omo-v1-unrelated-")
      const installPath = createInstallPath("omo-v1-install-")

      writeDatabase(pluginsHome, {
        version: 1,
        plugins: {
          "user-plugin@market": {
            scope: "user",
            installPath,
            version: "1.0.0",
            installedAt: "2026-03-25T00:00:00Z",
            lastUpdated: "2026-03-25T00:00:00Z",
          },
        },
      })
      process.chdir(unrelatedDirectory)

      const discovered = await discover(pluginsHome, "v1-user")

      expect(discovered.errors).toHaveLength(0)
      expect(discovered.plugins).toHaveLength(1)
      expect(discovered.plugins[0]?.name).toBe("user-plugin")
    })
  })

  describe("project and local scoped entries in v2 format", () => {
    it("loads matching project entries and drops non-matching entries", async () => {
      const pluginsHome = process.env.CLAUDE_PLUGINS_HOME as string
      const projectDirectory = createTemporaryDirectory("omo-v2-project-")
      const otherDirectory = createTemporaryDirectory("omo-v2-other-")
      const matchingInstall = createInstallPath("omo-v2-match-install-")
      const missingInstall = createInstallPath("omo-v2-miss-install-")
      const userInstall = createInstallPath("omo-v2-user-install-")

      writeDatabase(pluginsHome, {
        version: 2,
        plugins: {
          "matching-project@market": [
            {
              scope: "project",
              projectPath: projectDirectory,
              installPath: matchingInstall,
              version: "1.0.0",
              installedAt: "2026-03-25T00:00:00Z",
              lastUpdated: "2026-03-25T00:00:00Z",
            },
          ],
          "other-project@market": [
            {
              scope: "project",
              projectPath: otherDirectory,
              installPath: missingInstall,
              version: "1.0.0",
              installedAt: "2026-03-25T00:00:00Z",
              lastUpdated: "2026-03-25T00:00:00Z",
            },
          ],
          "global-user@market": [
            {
              scope: "user",
              installPath: userInstall,
              version: "2.0.0",
              installedAt: "2026-03-25T00:00:00Z",
              lastUpdated: "2026-03-25T00:00:00Z",
            },
          ],
        },
      })
      process.chdir(projectDirectory)

      const discovered = await discover(pluginsHome, "v2-mixed")

      expect(discovered.errors).toHaveLength(0)
      expect(discovered.plugins.map((plugin) => plugin.name).sort()).toEqual([
        "global-user",
        "matching-project",
      ])
    })

    it("loads local-scoped entries when cwd matches projectPath", async () => {
      const pluginsHome = process.env.CLAUDE_PLUGINS_HOME as string
      const projectDirectory = createTemporaryDirectory("omo-v2-local-match-")
      const installPath = createInstallPath("omo-v2-local-install-")

      writeDatabase(pluginsHome, {
        version: 2,
        plugins: {
          "local-plugin@market": [
            {
              scope: "local",
              projectPath: projectDirectory,
              installPath,
              version: "1.0.0",
              installedAt: "2026-03-25T00:00:00Z",
              lastUpdated: "2026-03-25T00:00:00Z",
            },
          ],
        },
      })
      process.chdir(projectDirectory)

      const discovered = await discover(pluginsHome, "v2-local-match")

      expect(discovered.errors).toHaveLength(0)
      expect(discovered.plugins).toHaveLength(1)
      expect(discovered.plugins[0]?.name).toBe("local-plugin")
    })

    it("skips local-scoped entries when cwd does not match projectPath", async () => {
      const pluginsHome = process.env.CLAUDE_PLUGINS_HOME as string
      const projectDirectory = createTemporaryDirectory("omo-v2-local-miss-")
      const otherDirectory = createTemporaryDirectory("omo-v2-local-other-")
      const installPath = createInstallPath("omo-v2-local-install-")

      writeDatabase(pluginsHome, {
        version: 2,
        plugins: {
          "local-plugin@market": [
            {
              scope: "local",
              projectPath: projectDirectory,
              installPath,
              version: "1.0.0",
              installedAt: "2026-03-25T00:00:00Z",
              lastUpdated: "2026-03-25T00:00:00Z",
            },
          ],
        },
      })
      process.chdir(otherDirectory)

      const discovered = await discover(pluginsHome, "v2-local-miss")

      expect(discovered.errors).toHaveLength(0)
      expect(discovered.plugins).toHaveLength(0)
    })

    it("considers only the first installation for a plugin key", async () => {
      const pluginsHome = process.env.CLAUDE_PLUGINS_HOME as string
      const projectDirectory = createTemporaryDirectory("omo-v2-multi-")
      const otherDirectory = createTemporaryDirectory("omo-v2-multi-other-")
      const primaryInstall = createInstallPath("omo-v2-multi-primary-")
      const secondaryInstall = createInstallPath("omo-v2-multi-secondary-")

      writeDatabase(pluginsHome, {
        version: 2,
        plugins: {
          "multi-plugin@market": [
            {
              scope: "project",
              projectPath: otherDirectory,
              installPath: primaryInstall,
              version: "1.0.0",
              installedAt: "2026-03-25T00:00:00Z",
              lastUpdated: "2026-03-25T00:00:00Z",
            },
            {
              scope: "project",
              projectPath: projectDirectory,
              installPath: secondaryInstall,
              version: "2.0.0",
              installedAt: "2026-03-25T00:00:00Z",
              lastUpdated: "2026-03-25T00:00:00Z",
            },
          ],
        },
      })
      process.chdir(projectDirectory)

      const discovered = await discover(pluginsHome, "v2-first-install")

      expect(discovered.errors).toHaveLength(0)
      expect(discovered.plugins).toHaveLength(0)
    })
  })

  describe("project and local scoped entries in v3 flat-array format", () => {
    it("loads a project-scoped entry when cwd matches projectPath", async () => {
      const pluginsHome = process.env.CLAUDE_PLUGINS_HOME as string
      const projectDirectory = createTemporaryDirectory("omo-v3-match-")
      const installPath = createInstallPath("omo-v3-install-")

      writeDatabase(pluginsHome, [
        {
          name: "v3-project-plugin",
          marketplace: "market",
          scope: "project",
          projectPath: projectDirectory,
          installPath,
          version: "1.0.0",
          lastUpdated: "2026-03-25T00:00:00Z",
        },
      ])
      process.chdir(projectDirectory)

      const discovered = await discover(pluginsHome, "v3-match")

      expect(discovered.errors).toHaveLength(0)
      expect(discovered.plugins).toHaveLength(1)
      expect(discovered.plugins[0]?.name).toBe("v3-project-plugin")
    })

    it("skips non-matching project entries while retaining user entries", async () => {
      const pluginsHome = process.env.CLAUDE_PLUGINS_HOME as string
      const projectDirectory = createTemporaryDirectory("omo-v3-miss-")
      const otherDirectory = createTemporaryDirectory("omo-v3-miss-other-")
      const installPath = createInstallPath("omo-v3-install-")

      writeDatabase(pluginsHome, [
        {
          name: "v3-skipped-plugin",
          marketplace: "market",
          scope: "project",
          projectPath: projectDirectory,
          installPath,
          version: "1.0.0",
          lastUpdated: "2026-03-25T00:00:00Z",
        },
        {
          name: "v3-user-plugin",
          marketplace: "market",
          scope: "user",
          installPath: createInstallPath("omo-v3-user-install-"),
          version: "2.0.0",
          lastUpdated: "2026-03-25T00:00:00Z",
        },
      ])
      process.chdir(otherDirectory)

      const discovered = await discover(pluginsHome, "v3-mismatch")

      expect(discovered.errors).toHaveLength(0)
      expect(discovered.plugins).toHaveLength(1)
      expect(discovered.plugins[0]?.name).toBe("v3-user-plugin")
    })
  })

  describe("enabledPluginsOverride combined with scope filtering", () => {
    it("skips a matching project-scoped plugin disabled by override", async () => {
      const pluginsHome = process.env.CLAUDE_PLUGINS_HOME as string
      const projectDirectory = createTemporaryDirectory("omo-enabled-proj-")
      const installPath = createInstallPath("omo-enabled-install-")

      writeDatabase(pluginsHome, {
        version: 2,
        plugins: {
          "gated-plugin@market": [
            {
              scope: "project",
              projectPath: projectDirectory,
              installPath,
              version: "1.0.0",
              installedAt: "2026-03-25T00:00:00Z",
              lastUpdated: "2026-03-25T00:00:00Z",
            },
          ],
        },
      })
      process.chdir(projectDirectory)

      const discovered = await discover(pluginsHome, "enabled-off", {
        enabledPluginsOverride: { "gated-plugin@market": false },
      })

      expect(discovered.errors).toHaveLength(0)
      expect(discovered.plugins).toHaveLength(0)
    })

    it("loads a matching project-scoped plugin enabled by override", async () => {
      const pluginsHome = process.env.CLAUDE_PLUGINS_HOME as string
      const projectDirectory = createTemporaryDirectory("omo-enabled-match-")
      const installPath = createInstallPath("omo-enabled-match-install-")

      writeDatabase(pluginsHome, {
        version: 2,
        plugins: {
          "enabled-plugin@market": [
            {
              scope: "project",
              projectPath: projectDirectory,
              installPath,
              version: "1.0.0",
              installedAt: "2026-03-25T00:00:00Z",
              lastUpdated: "2026-03-25T00:00:00Z",
            },
          ],
        },
      })
      process.chdir(projectDirectory)

      const discovered = await discover(pluginsHome, "enabled-on", {
        enabledPluginsOverride: { "enabled-plugin@market": true },
      })

      expect(discovered.errors).toHaveLength(0)
      expect(discovered.plugins).toHaveLength(1)
      expect(discovered.plugins[0]?.name).toBe("enabled-plugin")
    })

    it("applies overrides to normalized npm-prefixed plugin keys", async () => {
      const pluginsHome = process.env.CLAUDE_PLUGINS_HOME as string
      const projectDirectory = createTemporaryDirectory("omo-enabled-normalized-")
      const installPath = createInstallPath("omo-enabled-normalized-install-")

      writeDatabase(pluginsHome, {
        version: 2,
        plugins: {
          "npm:oh-my-claudecode@omc@1.0.0": [
            {
              scope: "project",
              projectPath: projectDirectory,
              installPath,
              version: "1.0.0",
              installedAt: "2026-03-25T00:00:00Z",
              lastUpdated: "2026-03-25T00:00:00Z",
            },
          ],
        },
      })
      process.chdir(projectDirectory)

      const discovered = await discover(pluginsHome, "enabled-normalized-off", {
        enabledPluginsOverride: { "oh-my-claudecode@omc": false },
      })

      expect(discovered.errors).toHaveLength(0)
      expect(discovered.plugins).toHaveLength(0)
    })
  })

  describe("stale installed_plugins.json paths", () => {
    function writePluginManifest(installPath: string, manifest: Record<string, unknown>): void {
      const manifestDirectory = join(installPath, ".claude-plugin")
      mkdirSync(manifestDirectory, { recursive: true })
      writeFileSync(
        join(manifestDirectory, "plugin.json"),
        JSON.stringify(manifest),
        "utf-8",
      )
    }

    it("recovers a sibling version directory when configured path ends in unknown", async () => {
      const pluginsHome = process.env.CLAUDE_PLUGINS_HOME as string
      const cacheRoot = createTemporaryDirectory("omo-cc-plus-cache-")
      const pluginRoot = join(cacheRoot, "cc-plus-marketplace", "cc-plus")
      const realInstallPath = join(pluginRoot, "0.1.0")
      const configuredInstallPath = join(pluginRoot, "unknown")

      mkdirSync(realInstallPath, { recursive: true })
      writePluginManifest(realInstallPath, { name: "cc-plus", version: "0.1.0" })

      writeDatabase(pluginsHome, {
        version: 2,
        plugins: {
          "cc-plus@cc-plus-marketplace": [
            {
              scope: "user",
              installPath: configuredInstallPath,
              version: "unknown",
              installedAt: "2025-11-01T13:05:32.029Z",
              lastUpdated: "2025-11-01T22:22:30.000Z",
            },
          ],
        },
      })

      const discovered = await discover(pluginsHome, "stale-unknown", {
        enabledPluginsOverride: { "cc-plus@cc-plus-marketplace": true },
        loadPluginManifestOverride: undefined,
      })

      expect(discovered.errors).toHaveLength(0)
      expect(discovered.plugins).toHaveLength(1)
      expect(discovered.plugins[0]?.installPath).toBe(realInstallPath)
      expect(discovered.plugins[0]?.name).toBe("cc-plus")
    })
  })
})
