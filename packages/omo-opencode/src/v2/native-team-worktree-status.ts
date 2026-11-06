import { lstat } from "node:fs/promises"

export type NativeWorktreeStatus = {
  readonly directory: string
  readonly exists: boolean
  readonly sha?: string
  readonly shortSha?: string
  readonly dirty?: boolean
  readonly ahead?: number
  readonly reason?: string
}

export class NativeWorktreeKeptError extends Error {
  constructor(public readonly worktree: NativeWorktreeStatus) {
    super(`Kept native worktree ${worktree.directory}: ${worktree.reason} (HEAD ${worktree.shortSha ?? "unknown"})`)
    this.name = "NativeWorktreeKeptError"
  }
}

async function git(directory: string, args: readonly string[]) {
  const child = Bun.spawn(["git", "-C", directory, ...args], { stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code !== 0 && !(args[0] === "merge-base" && code === 1)) {
    throw new Error(`git ${args[0]} exited ${code}: ${stderr.trim()}`)
  }
  return { code, stdout: stdout.trim() }
}

export async function inspectNativeWorktree(directory: string, sourceDirectory: string): Promise<NativeWorktreeStatus> {
  let sha: string | undefined
  try {
    const exists = await lstat(directory).then(() => true, (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
      throw error
    })
    if (!exists) return { directory, exists: false }
    sha = (await git(directory, ["rev-parse", "HEAD"])).stdout
    const dirty = (await git(directory, ["status", "--porcelain=v1", "--untracked-files=normal"])).stdout.length > 0
    const sourceHead = (await git(sourceDirectory, ["rev-parse", "HEAD"])).stdout
    const integrated = (await git(directory, ["merge-base", "--is-ancestor", sha, sourceHead])).code === 0
      || (await git(directory, ["for-each-ref", `--contains=${sha}`, "--count=1", "--format=%(refname)", "refs/heads"])).stdout.length > 0
    const ahead = Number((await git(directory, ["rev-list", "--count", `${sourceHead}..${sha}`])).stdout)
    const reasons = [
      ...(dirty ? ["dirty (uncommitted or untracked changes)"] : []),
      ...(!integrated ? [`unintegrated (${ahead} commits ahead of source HEAD)`] : []),
    ]
    return { directory, exists: true, sha, shortSha: sha.slice(0, 12), dirty, ahead, reason: reasons.length ? reasons.join("; ") : undefined }
  } catch (error) {
    return { directory, exists: true, sha, shortSha: sha?.slice(0, 12), reason: `inspection failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}
