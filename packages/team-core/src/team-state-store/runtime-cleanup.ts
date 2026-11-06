import { stat } from "node:fs/promises"

import type { TeamModeConfig } from "../config"
import { getRuntimeStateDir, resolveBaseDir } from "../team-registry/paths"
import { publishTeamRuntimeChange } from "./changes"
import { loadRuntimeState } from "./store"
import { getRuntimeWorktreePaths, removeProtectedRuntimeDirectory } from "./runtime-directory-removal"

function isEnoentError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT"
}

async function runtimeDirectoryExists(teamRunId: string, config: TeamModeConfig): Promise<boolean> {
  try {
    await stat(getRuntimeStateDir(resolveBaseDir(config), teamRunId))
    return true
  } catch (error) {
    if (isEnoentError(error)) return false
    throw error
  }
}

export async function removeRuntimeDirectory(teamRunId: string, config: TeamModeConfig, projectDirectory?: string): Promise<boolean> {
  if (!(await runtimeDirectoryExists(teamRunId, config))) return false
  const runtimeState = await loadRuntimeState(teamRunId, config).catch((error: unknown) => {
    if (isEnoentError(error)) return undefined
    throw error
  })
  if (!runtimeState) return false
  await removeProtectedRuntimeDirectory(getRuntimeStateDir(resolveBaseDir(config), teamRunId), getRuntimeWorktreePaths(runtimeState, runtimeState.projectDirectory ?? projectDirectory))
  publishTeamRuntimeChange(teamRunId)
  return true
}
