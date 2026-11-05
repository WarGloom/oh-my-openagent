import type { PluginInput } from "@opencode-ai/plugin"
import { NativeSkillError } from "./native-skill-expansion"
import { getNativeSkillState } from "./native-skill-state"
import { resolveNativeSkill } from "./native-skill-tool"

export type NativeDelegatedSkillSelection = {
  readonly id: string
  readonly arguments?: string
  readonly mention?: { readonly start: number; readonly end: number; readonly text: string }
}

export async function activateNativeSubagentSkills(input: PluginInput, request: {
  readonly admissionID: string
  readonly promptID: string
  readonly names: ReadonlyArray<string>
  readonly sessionID: string
  readonly agent: string
  readonly arguments?: string
  readonly commandSkills?: ReadonlyArray<NativeDelegatedSkillSelection>
}) {
  const state = getNativeSkillState(input)
  if (!state) throw new NativeSkillError("", "Native skill state is unavailable")
  const catalog = (await state.context.skill.list()).data
  const selections: NativeDelegatedSkillSelection[] = (request.commandSkills ?? []).map((selection) => {
    if (!catalog.some((skill) => skill.id === selection.id)) throw new NativeSkillError(selection.id, "Command skill ID was not found")
    return { ...selection }
  })
  for (const name of request.names) {
    const skill = resolveNativeSkill(catalog, name)
    if (selections.some((selection) => selection.id === skill.id && selection.arguments === request.arguments)) continue
    selections.push({ id: skill.id, ...(request.arguments === undefined ? {} : { arguments: request.arguments }) })
  }
  const snapshots = await state.context.experimental.subagent.acceptSkills({
    admissionID: request.admissionID,
    promptID: request.promptID,
    skills: selections.map((selection) => ({ skill: selection.id, ...(selection.arguments === undefined ? {} : { arguments: selection.arguments }) })),
  })
  if (snapshots.length !== selections.length) throw new NativeSkillError("", "Native skill admission returned an incomplete receipt")
  const resolved = selections.map((selection, index) => {
    const snapshot = snapshots[index]
    if (!snapshot || snapshot.skill.id !== selection.id || snapshot.sessionID !== request.sessionID || snapshot.agent !== request.agent || snapshot.arguments !== selection.arguments || snapshot.source.kind !== "prompt" || snapshot.source.messageID !== request.promptID || snapshot.source.selectionIndex !== index) {
      throw new NativeSkillError(selection.id, "Native skill admission receipt does not match the prepared target and selection")
    }
    return snapshot
  })
  return { text: resolved.map((snapshot) => snapshot.content).join("\n\n"), activationIDs: resolved.map((snapshot) => snapshot.activationID), selections, resolved }
}
