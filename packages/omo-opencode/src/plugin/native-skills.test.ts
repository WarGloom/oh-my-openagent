import { describe, expect, test } from "bun:test"
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import { createNativeLoadedSkillsResolver, createNativeSkills, getPluginInputNativeSkills } from "./native-skills"
import type { PluginContext } from "./types"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("native skill accessor", () => {
  test("restores OMO metadata from a native-only declared skill source without republishing its content", async () => {
    const directory = mkdtempSync(join(tmpdir(), "native-skill-metadata-"))
    const location = join(directory, "SKILL.md")
    writeFileSync(
      location,
      "---\nname: external\nagent: atlas\nlicense: MIT\nmcp:\n  declared:\n    command: not-executed\n---\nbody",
    )
    const native = { name: "external", location, content: "host-content", description: "host-description" }
    try {
      const resolve = createNativeLoadedSkillsResolver({
        skills: [],
        directory,
        disabledSkills: new Set(),
        nativeSkills: { all: () => [native], get: () => native, dirs: () => [directory] },
      })
      const result = await resolve()
      expect(result[0]).toMatchObject({
        name: "external",
        license: "MIT",
        definition: { agent: "atlas", template: "host-content" },
        mcpConfig: { declared: { command: "not-executed" } },
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  test("uses PluginContext.skills when the host exposes it directly", () => {
    const directNativeSkills = {
      all() {
        return []
      },
      get() {
        return undefined
      },
      dirs() {
        return []
      },
    }
    const ctx = unsafeTestValue<PluginContext>({ skills: directNativeSkills })

    const result = getPluginInputNativeSkills(ctx)

    expect(result).toBe(directNativeSkills)
  })

  test("loads native skills through the v2 app.skills method on the generated client", async () => {
    const calls: unknown[] = []
    const generatedClient = {
      async get(options: unknown) {
        calls.push(options)
        return {
          data: [
            {
              name: "customize-opencode",
              description: "Customize OpenCode",
              location: "/opencode/customize-opencode.md",
              content: "# Customizing opencode",
            },
          ],
          request: new Request("http://localhost/skill"),
          response: new Response(null),
        }
      },
    }
    const nativeSkills = createNativeSkills({
      client: unsafeTestValue<PluginContext["client"]>({ _client: generatedClient }),
      directory: "/repo",
    })

    const result = await nativeSkills.all()

    expect(result).toEqual([
      {
        name: "customize-opencode",
        description: "Customize OpenCode",
        location: "/opencode/customize-opencode.md",
        content: "# Customizing opencode",
      },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ url: "/skill", query: { directory: "/repo" } })
  })
})
