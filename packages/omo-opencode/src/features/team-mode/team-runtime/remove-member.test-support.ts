import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { TeamModeConfigSchema } from "../../../config/schema/team-mode"
import { TeamSpecSchema } from "@oh-my-opencode/team-core/types"
import { createRuntimeState, transitionRuntimeState } from "../team-state-store/store"
import { clearTeamSessionRegistry } from "../team-session-registry"

export function createRemovalTestContext() {
  const directories: string[] = []
  async function cleanup() {
    clearTeamSessionRegistry()
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  }

  async function fixture() {
    const baseDir = await mkdtemp(path.join(tmpdir(), "team-remove-"))
    directories.push(baseDir)
    const config = TeamModeConfigSchema.parse({ enabled: true, base_dir: baseDir })
    const spec = TeamSpecSchema.parse({ name: "alpha", leadAgentId: "lead", members: [
      { name: "lead", kind: "subagent_type", subagent_type: "atlas" },
      { name: "worker", kind: "subagent_type", subagent_type: "sisyphus" },
    ] })
    const created = await createRuntimeState(spec, "lead-session", "project", config)
    const state = await transitionRuntimeState(created.teamRunId, current => ({ ...current, status: "active", members: current.members.map(member => ({
      ...member, sessionId: member.name === "lead" ? "lead-session" : "worker-session", status: "running",
    })) }), config)
    return { config, state, teamRunId: state.teamRunId, memberName: "worker", leadSessionId: "lead-session" }
  }

  return { fixture, cleanup }
}
