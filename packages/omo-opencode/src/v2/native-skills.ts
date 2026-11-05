import type { PluginInput } from "@opencode-ai/plugin"
import type { LoadedSkill } from "../features/opencode-skill-loader"
import { extractSkillBody } from "../tools/skill/skill-body"
import type { V2Registration } from "./context-types"
import { getNativeSkillState } from "./native-skill-state"
import type { V2SkillInfo } from "./native-skill-types"
import { installNativeSkillActivation } from "./native-skill-activation"
import { decorateNativeSkillTool } from "./native-skill-tool"

export async function installNativeSkills(input: PluginInput): Promise<V2Registration | undefined> {
  const state = getNativeSkillState(input)
  if (!state?.options) return
  const options = state.options
  const loaded = options.skills ?? (options.getLoadedSkills ? await options.getLoadedSkills() : [])
  const discovered = options.getLoadedSkills ? await options.getLoadedSkills() : loaded
  const entries: LoadedSkill[] = [...loaded]
  for (const command of options.commands ?? []) {
    if (entries.some((skill) => skill.name === command.name)) continue
    const skill: LoadedSkill = {
      name: command.name, path: command.path, scope: "config",
      definition: { name: command.name, description: command.metadata.description, template: command.content ?? "" },
      ...(command.lazyContentLoader ? { lazyContent: command.lazyContentLoader } : {}),
    }
    entries.push(skill)
    state.commands.set(skill, command)
  }
  const prepared = await Promise.all(entries.map(async (skill) => ({ skill, content: await extractSkillBody(skill) })))
  const skills = await state.context.skill.transform((editor) => {
    state.entries.clear()
    state.published.clear()
    state.hostEntries.clear()
    for (const existing of editor.list()) {
      const metadata = discovered.find((skill) => skill.name === existing.name && skill.path === existing.path)
      if (metadata && (metadata.mcpConfig || metadata.definition.agent)) {
        state.entries.set(existing.id, metadata)
        state.published.set(existing.id, existing)
        state.hostEntries.add(existing.id)
        if (metadata.definition.agent) editor.update(existing.id, (skill) => { skill.autoinvoke = false })
      }
    }
    for (const existing of editor.list()) {
      if (options.disabledSkills?.has(existing.id) || options.disabledSkills?.has(existing.name)) {
        editor.remove(existing.id)
        state.entries.delete(existing.id)
        state.published.delete(existing.id)
        state.hostEntries.delete(existing.id)
      }
    }
    for (const { skill, content } of prepared) {
      const existing = editor.list().find((entry) => entry.id === skill.name || entry.name.toLowerCase() === skill.name.toLowerCase())
      const id = existing?.id ?? skill.name
      const published: V2SkillInfo = {
        id, name: skill.name, description: skill.definition.description,
        path: skill.path ?? existing?.path ?? `skill://${id}/SKILL.md`, content,
        ...(skill.definition.agent ? { autoinvoke: false } : existing?.autoinvoke === undefined ? {} : { autoinvoke: existing.autoinvoke }),
      }
      editor.add(published)
      state.entries.set(id, skill)
      state.hostEntries.delete(id)
      state.published.set(id, published)
    }
  })
  let activation: V2Registration | undefined
  try {
    activation = await installNativeSkillActivation(state)
    const installedActivation = activation
    const tool = await state.context.tool.transform((editor) => decorateNativeSkillTool(editor, state))
    return { dispose: async () => { await tool.dispose(); await installedActivation.dispose(); await skills.dispose(); state.entries.clear(); state.commands.clear(); state.published.clear(); state.hostEntries.clear() } }
  } catch (error) {
    await activation?.dispose()
    await skills.dispose()
    throw error
  }
}
