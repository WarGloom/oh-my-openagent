import type { PluginInput } from "@opencode-ai/plugin"
import { getNativeSkillState } from "./native-skill-state"
import { NativeSkillError } from "./native-skill-expansion"

export async function restoreNativeSkills(input: PluginInput, request: {
  readonly sessionID: string
  readonly agent: string
  readonly activationIDs: ReadonlyArray<string>
}) {
  const state = getNativeSkillState(input)
  if (!state) throw new NativeSkillError("", "Native skill state is unavailable")
  const snapshots = await state.context.experimental.skill.activations({ sessionID: request.sessionID })
  const resolved = request.activationIDs.map((id) => {
    const snapshot = snapshots.find((entry) => entry.activationID === id && entry.sessionID === request.sessionID && entry.agent === request.agent)
    if (!snapshot) throw new NativeSkillError(id, `Accepted skill activation "${id}" is unavailable for the target session and agent`)
    return snapshot
  })
  return { text: resolved.map((snapshot) => snapshot.content).join("\n\n"), resolved }
}
