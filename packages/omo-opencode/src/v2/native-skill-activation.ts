import { createHash } from "node:crypto"
import type { LoadedSkill } from "../features/opencode-skill-loader"
import type { NativeSkillState } from "./native-skill-state"
import { getNativeLoadedSkill } from "./native-skill-state"
import { expandLoadedSkill } from "./native-skill-expansion"
import type { V2SkillInfo } from "./native-skill-types"
import { readSkillFileChecked, skillProvenance } from "@oh-my-opencode/skills-loader-core/opencode-skill-loader"

export function nativeSkillDescriptor(skill: LoadedSkill, native: V2SkillInfo) {
  const source = skill.mcpSourcePath ?? skill.path ?? skill.resolvedPath ?? native.path
  const provenance = skill.path ? skillProvenance(skill.path, skill.scope, skill.provenance) : skill.provenance
  const declaration = skill.path && provenance ? {
    skill: readSkillFileChecked(skill.path, provenance),
    mcp: skill.mcpSourcePath && skill.mcpSourcePath !== skill.path ? readSkillFileChecked(skill.mcpSourcePath, provenance) : undefined,
  } : { content: native.content, mcp: skill.mcpConfig }
  return {
    id: native.id,
    name: skill.name,
    source,
    revision: createHash("sha256").update(JSON.stringify({ source, provenance, declaration })).digest("hex"),
    servers: Object.keys(skill.mcpConfig ?? {}).sort(),
  }
}

export async function installNativeSkillActivation(state: NativeSkillState) {
  return state.context.skill.hook("experimental.activate", async (event) => {
    if (!event.decision.allow) return
    const loaded = getNativeLoadedSkill(state, event.skill)
    if (!loaded || !state.options) return
    if (loaded.definition.agent && loaded.definition.agent !== event.agent) {
      event.decision = { allow: false, reason: `Skill "${loaded.name}" is restricted to agent "${loaded.definition.agent}"` }
      return
    }
    const expanded = await expandLoadedSkill(loaded, state.options, {
      agent: event.agent, sessionID: event.sessionID, arguments: event.arguments, command: state.commands.get(loaded),
      nativeContent: state.hostEntries.has(event.skill.id) ? event.content : undefined,
    })
    event.content = expanded.content
    event.metadata["omo.skill"] = nativeSkillDescriptor(loaded, event.skill)
  })
}
