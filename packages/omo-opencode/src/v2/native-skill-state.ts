import type { PluginInput } from "@opencode-ai/plugin"
import type { LoadedSkill } from "../features/opencode-skill-loader"
import type { SkillLoadOptions } from "../tools/skill/types"
import type { V2PluginContext } from "./context-types"
import type { CommandInfo } from "../tools/slashcommand/types"
import type { V2SkillInfo } from "./native-skill-types"

export type NativeSkillState = {
  readonly context: V2PluginContext
  readonly entries: Map<string, LoadedSkill>
  readonly commands: Map<LoadedSkill, CommandInfo>
  readonly published: Map<string, V2SkillInfo>
  readonly hostEntries: Set<string>
  options?: SkillLoadOptions
}

const inputs = new WeakMap<PluginInput, NativeSkillState>()

export function attachNativeSkillState(input: PluginInput, context: V2PluginContext): void {
  inputs.set(input, { context, entries: new Map(), commands: new Map(), published: new Map(), hostEntries: new Set() })
}

export function getNativeSkillState(input: PluginInput): NativeSkillState | undefined {
  return inputs.get(input)
}

export function setNativeSkillOptions(input: PluginInput, options: SkillLoadOptions): void {
  const state = inputs.get(input)
  if (state) state.options = options
}

export function getNativeLoadedSkill(state: NativeSkillState, skill: V2SkillInfo): LoadedSkill | undefined {
  const published = state.published.get(skill.id)
  return published?.content.trim() === skill.content.trim() && published.name === skill.name && published.path === skill.path
    ? state.entries.get(skill.id) : undefined
}
