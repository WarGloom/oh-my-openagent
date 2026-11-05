import { describe, expect, it, spyOn } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { getModelResolutionInfoWithOverrides } from "../../cli/doctor/checks/model-resolution"
import * as capabilities from "../../shared/model-capabilities"
import { resolveRoster } from "./roster-resolver"

type EnvSnapshot = {
  readonly HOME: string | undefined
  readonly OPENCODE_CONFIG_DIR: string | undefined
  readonly XDG_CONFIG_HOME: string | undefined
}

const ENV_KEYS = ["HOME", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME"] as const

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const key of ENV_KEYS) {
    const value = snapshot[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function withIsolatedConfig<T>(name: string, run: (root: string) => T): T {
  const original: EnvSnapshot = {
    HOME: process.env.HOME,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  }
  const root = join(tmpdir(), `omo-tui-roster-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`)

  try {
    mkdirSync(root, { recursive: true })
    process.env.HOME = root
    process.env.OPENCODE_CONFIG_DIR = join(root, "custom-config")
    process.env.XDG_CONFIG_HOME = join(root, "xdg-config")
    return run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
    restoreEnv(original)
  }
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(join(filePath, ".."), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
}

describe("resolveRoster", () => {
  it("#given no config #when resolving roster #then it returns default resolver rows", () => {
    withIsolatedConfig("defaults", (root) => {
      // given
      const project = join(root, "project")
      mkdirSync(project, { recursive: true })

      // when
      const rows = resolveRoster(project)

      // then
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.some((row) => row.label === "sisyphus")).toBe(true)
      expect(rows.some((row) => row.label === "deep-low")).toBe(true)
    })
  })

  it("#given agent and category overrides #when resolving roster #then it preserves doctor selections without capability diagnostics", () => {
    withIsolatedConfig("overrides", (root) => {
      // given
      const project = join(root, "project")
      const config = {
          agents: {
            sisyphus: { model: "provider/family/model-leaf" },
            atlas: { model: "" },
            oracle: { category: "deep-low" },
          },
          categories: {
            "deep-low": { model: "simple-model" },
            quick: { model: "provider/" },
          },
      }
      writeJson(join(project, ".omo", "omo.jsonc"), {
        "[opencode]": config,
      })
      const doctor = getModelResolutionInfoWithOverrides(config)
      expect(doctor.agents.find((entry) => entry.name === "sisyphus")?.capabilityDiagnostics).toBeDefined()
      const expectedRows = [...doctor.agents, ...doctor.categories].map((entry) => ({
        label: entry.name,
        model: entry.effectiveModel.slice(entry.effectiveModel.lastIndexOf("/") + 1) || entry.effectiveModel,
      })).sort((left, right) => left.label.localeCompare(right.label))
      const capabilityLookup = spyOn(capabilities, "getModelCapabilities")

      try {
        // when
        const rows = resolveRoster(project)

        // then
        expect(rows).toEqual(expectedRows)
        expect(rows).toContainEqual({ label: "sisyphus", model: "model-leaf" })
        expect(rows).toContainEqual({ label: "deep-low", model: "simple-model" })
        expect(capabilityLookup).not.toHaveBeenCalled()
      } finally {
        capabilityLookup.mockRestore()
      }
    })
  })

  it("#given disabled_agents config #when resolving roster #then it excludes disabled builtin agents", () => {
    withIsolatedConfig("disabled-agents", (root) => {
      // given
      const project = join(root, "project")
      writeJson(join(project, ".omo", "omo.jsonc"), {
        "[opencode]": {
          disabled_agents: ["hephaestus"],
        },
      })

      // when
      const rows = resolveRoster(project)

      // then
      expect(rows.some((row) => row.label === "hephaestus")).toBe(false)
      expect(rows.some((row) => row.label === "sisyphus")).toBe(true)
    })
  })

  it("#given legacy alias in disabled_agents #when resolving roster #then it excludes the canonical agent", () => {
    withIsolatedConfig("disabled-agents-alias", (root) => {
      // given
      const project = join(root, "project")
      writeJson(join(project, ".omo", "omo.jsonc"), {
        "[opencode]": {
          disabled_agents: ["Hephaestus (Deep Agent)"],
        },
      })

      // when
      const rows = resolveRoster(project)

      // then
      expect(rows.some((row) => row.label === "hephaestus")).toBe(false)
    })
  })

  it("#given malformed config #when resolving roster #then it still returns resolver rows", () => {
    withIsolatedConfig("malformed", (root) => {
      // given
      const project = join(root, "project")
      writeJson(join(project, ".opencode", "omo.json"), {
        agents: { sisyphus: { model: 123 } },
      })

      // when
      const rows = resolveRoster(project)

      // then
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.some((row) => row.label === "sisyphus")).toBe(true)
    })
  })
})
