import { execFileSync } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverOpencodeProjectSkills, discoverProjectAgentsSkills, discoverProjectClaudeSkills } from "./loader"
import * as utils from "@oh-my-opencode/utils"
import { loadSkillFromPath } from "./loaded-skill-from-path"
import { subscribeSkillDiagnostics, type SkillDiagnostic } from "./skill-provenance"

function writeSkill(directory: string, name: string, description: string): void {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`)
}

describe("project skill discovery", () => {
  let tempDir = ""

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "omo-project-skill-discovery-"))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("skips optional dangling links on repeated discovery and discovers repaired targets", async () => {
    // given
    const skillsDir = join(tempDir, ".claude", "skills")
    const target = join(tempDir, ".agents", "skills", "repaired")
    writeSkill(join(skillsDir, "sibling"), "sibling", "Valid sibling")
    symlinkSync(target, join(skillsDir, "repaired"))
    const diagnostics: SkillDiagnostic[] = []
    const logs: unknown[] = []
    const unsubscribe = subscribeSkillDiagnostics((diagnostic) => diagnostics.push(diagnostic))
    const logger = spyOn(utils, "log").mockImplementation((_message, data) => {
      logs.push(data)
    })
    try {
      // when
      const scans = []
      for (let scan = 0; scan < 3; scan++) {
        scans.push((await discoverProjectClaudeSkills(tempDir)).map((skill) => skill.name))
      }
      // then
      expect(scans).toEqual([["sibling"], ["sibling"], ["sibling"]])
      expect(diagnostics).toEqual([])
      expect(logs).toEqual(Array.from({ length: 3 }, () => ({ path: join(skillsDir, "repaired"), code: "ENOENT" })))

      // when the target becomes available, discovery must retry without a cache reset.
      writeSkill(target, "repaired", "Repaired target")
      const repaired = await discoverProjectClaudeSkills(tempDir)
      // then
      expect(repaired.map((skill) => skill.name).sort()).toEqual(["repaired", "sibling"])
      expect(repaired.find((skill) => skill.name === "repaired")?.definition.name).toBe("repaired")
    } finally {
      unsubscribe()
      logger.mockRestore()
    }
  })

  it("reports an explicit missing skill load as an actionable error", async () => {
    // given
    const path = join(tempDir, "requested", "SKILL.md")
    const diagnostics: SkillDiagnostic[] = []
    // when
    const loaded = await loadSkillFromPath({
      skillPath: path,
      resolvedPath: tempDir,
      defaultName: "requested",
      scope: "project",
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    // then
    expect(loaded).toBeNull()
    expect(diagnostics.map((diagnostic) => [diagnostic.category, diagnostic.path])).toEqual([
      ["skill-load-error", path],
    ])
    expect(diagnostics[0]?.message).toContain("ENOENT")
  })

  it("discovers ancestor project skill directories up to the worktree root", async () => {
    // given
    const repositoryDir = join(tempDir, "repo")
    const nestedDirectory = join(repositoryDir, "packages", "app", "src")

    mkdirSync(nestedDirectory, { recursive: true })
    execFileSync("git", ["init"], {
      cwd: repositoryDir,
      stdio: ["ignore", "ignore", "ignore"],
    })

    writeSkill(
      join(repositoryDir, ".claude", "skills", "repo-claude"),
      "repo-claude",
      "Discovered from the repository root",
    )
    writeSkill(
      join(repositoryDir, ".agents", "skills", "repo-agents"),
      "repo-agents",
      "Discovered from the repository root",
    )
    writeSkill(
      join(repositoryDir, ".opencode", "skill", "repo-opencode"),
      "repo-opencode",
      "Discovered from the repository root",
    )

    writeSkill(
      join(tempDir, ".claude", "skills", "outside-claude"),
      "outside-claude",
      "Should stay outside the worktree",
    )
    writeSkill(
      join(tempDir, ".agents", "skills", "outside-agents"),
      "outside-agents",
      "Should stay outside the worktree",
    )
    writeSkill(
      join(tempDir, ".opencode", "skills", "outside-opencode"),
      "outside-opencode",
      "Should stay outside the worktree",
    )

    // when
    const [claudeSkills, agentSkills, opencodeSkills] = await Promise.all([
      discoverProjectClaudeSkills(nestedDirectory),
      discoverProjectAgentsSkills(nestedDirectory),
      discoverOpencodeProjectSkills(nestedDirectory),
    ])

    // then
    expect(claudeSkills.map((skill) => skill.name)).toEqual(["repo-claude"])
    expect(agentSkills.map((skill) => skill.name)).toEqual(["repo-agents"])
    expect(opencodeSkills.map((skill) => skill.name)).toEqual(["repo-opencode"])
  })
})
