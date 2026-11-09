import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, isAbsolute, relative, resolve, sep } from "node:path"

export const JEV_STATE_BUILDER_VERSION = "study-v2-parent-tree-briefs-v1"
export type BriefStatus = "none" | "resolved" | "unresolved" | "truncated"
export type BriefReason = "outside_root" | "missing" | "unreadable" | "symlink" | "not_regular" | "oversized"

function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

export async function resolveJevBriefs(
  prompt: string,
  directory: string,
): Promise<{ texts: string[]; status: BriefStatus; reasons: BriefReason[] }> {
  const paths: string[] = []
  const mdPath = /(?:~\/|\.\.\/|\.\/|\/)?[\w.@+-]+(?:\/[\w.@+-]+)*\.md\b/gi
  const pointerLanguage = /\b(?:read|follow|fulfil+l?|implement|execute|use|open|load|see|consult|brief|plan|task)\b/i
  for (const line of prompt.split(/\r?\n/)) {
    if (!pointerLanguage.test(line)) continue
    for (const match of line.matchAll(mdPath)) {
      if (
        /(?:brief|plan|gate-common)/i.test(basename(match[0])) ||
        /\b(?:brief|plan)(?:\s+file)?\s+(?:at|is|:)\s*$/i.test(line.slice(0, match.index))
      )
        paths.push(match[0])
    }
  }
  const texts: string[] = []
  const reasons = new Set<BriefReason>()
  if (!paths.length) return { texts, status: "none", reasons: [...reasons] }
  const root = await realpath(directory)
  for (const path of new Set(paths)) {
    const target = resolve(path.startsWith("~/") ? homedir() : root, path.startsWith("~/") ? path.slice(2) : path)
    if (!inside(root, target)) {
      reasons.add("outside_root")
      continue
    }
    try {
      let current = root
      let symlink = false
      for (const component of relative(root, target).split(sep)) {
        current = resolve(current, component)
        if ((await lstat(current)).isSymbolicLink()) {
          symlink = true
          break
        }
      }
      if (symlink) {
        const canonical = await realpath(target).catch(() => target)
        reasons.add(inside(root, canonical) ? "symlink" : "outside_root")
        continue
      }
      const canonical = await realpath(target)
      if (!inside(root, canonical)) {
        reasons.add("outside_root")
        continue
      }
      const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const stat = await file.stat()
        if (!stat.isFile()) {
          reasons.add("not_regular")
          continue
        }
        if ((stat.mode & 0o444) === 0) {
          reasons.add("unreadable")
          continue
        }
        if (stat.size > 1024 * 1024) {
          reasons.add("oversized")
          continue
        }
        const checked = await realpath(target)
        const currentStat = await lstat(checked)
        if (
          !inside(root, checked) ||
          checked !== canonical ||
          currentStat.ino !== stat.ino ||
          currentStat.dev !== stat.dev
        ) {
          reasons.add("outside_root")
          continue
        }
        const buffer = Buffer.alloc(1024 * 1024 + 1)
        let size = 0
        while (size < buffer.length) {
          const read = await file.read(buffer, size, buffer.length - size, size)
          if (read.bytesRead === 0) break
          size += read.bytesRead
        }
        if (size > 1024 * 1024) {
          reasons.add("oversized")
          continue
        }
        texts.push(buffer.subarray(0, size).toString("utf8"))
      } finally {
        await file.close()
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error
      reasons.add("code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR") ? "missing" : "unreadable")
    }
  }
  return { texts, status: reasons.size ? "unresolved" : "resolved", reasons: [...reasons] }
}
