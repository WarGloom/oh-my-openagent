import { lstat, readdir, realpath, rm, rmdir, unlink } from "node:fs/promises"
import path from "node:path"

import type { RuntimeState } from "../types"

export class RelativeMemberWorktreePathError extends Error {
  constructor(public readonly directory: string) {
    super(`Relative member worktree path requires its project directory: ${directory}`)
    this.name = "RelativeMemberWorktreePathError"
  }
}

export function resolveMemberWorktreePath(directory: string, projectDirectory?: string): string {
  if (path.isAbsolute(directory)) return path.resolve(directory)
  if (!projectDirectory) throw new RelativeMemberWorktreePathError(directory)
  return path.resolve(projectDirectory, directory)
}

export function getRuntimeWorktreePaths(state: RuntimeState, projectDirectory = state.projectDirectory): string[] {
  return [...state.members, ...(state.removedMembers ?? []).map((record) => record.member)].flatMap((member) =>
    [member.worktreePath, member.nativeWorktree?.directory]
      .filter((directory): directory is string => Boolean(directory))
      .map((directory) =>
        resolveMemberWorktreePath(directory, projectDirectory ?? member.nativeWorktree?.sourceDirectory),
      ),
  )
}

async function canonicalPath(directory: string): Promise<string> {
  try {
    return await realpath(directory)
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"))
      return path.resolve(directory)
    throw error
  }
}

export async function removeProtectedRuntimeDirectory(
  runtimeDirectory: string,
  memberDirectories: readonly string[],
): Promise<void> {
  const runtimeLeaf = path.join(await canonicalPath(path.dirname(runtimeDirectory)), path.basename(runtimeDirectory))
  const leafInfo = await lstat(runtimeLeaf).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (!leafInfo) return
  if (leafInfo.isSymbolicLink()) {
    await unlink(runtimeLeaf)
    return
  }
  const protectedPaths = await Promise.all(memberDirectories.map(canonicalPath))
  const removeEntry = async (directory: string): Promise<void> => {
    const canonical = await canonicalPath(directory)
    if (
      protectedPaths.some((memberPath) => canonical === memberPath || canonical.startsWith(`${memberPath}${path.sep}`))
    )
      return
    if (protectedPaths.some((memberPath) => memberPath.startsWith(`${canonical}${path.sep}`))) {
      if ((await lstat(directory)).isSymbolicLink()) return
      await Promise.all((await readdir(directory)).map((entry) => removeEntry(path.join(directory, entry))))
      await rmdir(directory).catch((error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ENOTEMPTY" || error.code === "EEXIST")
        )
          return
        throw error
      })
      return
    }
    await rm(directory, { recursive: true, force: true })
  }
  await removeEntry(runtimeLeaf)
}
