import type { V2PermissionRule } from "../context-types"

/**
 * Agent ids OMO preloads skills into. The host denies the `skill` action for these agents by default:
 * the Explore agent carries a leading `*`/`*` deny with no `skill` allow, so a preloaded skill such as
 * `codebase-memory` fails the host's pre-model `assertNotDenied({ action: "skill" })` check.
 */
const SKILL_PRELOAD_AGENT_IDS: ReadonlySet<string> = new Set(["explore"])

/**
 * The intentional OMO default that lets a skill-preloading agent run the `skill` action. The bridge
 * applies it before the user's own global and per-agent rules, so the host (last matching rule wins)
 * still lets an explicit user or project skill deny override it. It allows only the `skill` action, so
 * every other restriction the host or the user set (edit, subagent, shell, read) is left untouched.
 */
export function intendedSkillPermissions(agentID: string): ReadonlyArray<V2PermissionRule> {
  if (!SKILL_PRELOAD_AGENT_IDS.has(agentID)) return []
  return [{ action: "skill", resource: "*", effect: "allow" }]
}
