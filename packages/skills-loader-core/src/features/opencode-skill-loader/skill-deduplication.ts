import { realpathSync } from "node:fs"
import type { LoadedSkill } from "./types"

export function deduplicateSkillsByName(skills: LoadedSkill[]): LoadedSkill[] {
  const seen = new Set<string>()
  const result: LoadedSkill[] = []
  for (const skill of skills) {
    if (!seen.has(skill.name)) {
      seen.add(skill.name)
      result.push(skill)
    }
  }
  return result
}

export function skillFileIdentity(path: string): string {
  try {
    return realpathSync.native(path)
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return path
  }
}
