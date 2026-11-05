import { createHash } from "node:crypto"
import { z } from "zod"
import type { LoadedSkill } from "../features/opencode-skill-loader"
import { nativeSkillDescriptor } from "./native-skill-activation"
import { getNativeLoadedSkill, type NativeSkillState } from "./native-skill-state"
import type { V2SkillSnapshot } from "./native-skill-types"
import type { PluginInput } from "@opencode-ai/plugin"
import { getNativeSkillState } from "./native-skill-state"
import { NativeSkillError } from "./native-skill-expansion"

const Descriptor = z.object({
  id: z.string(), name: z.string(), source: z.string(), revision: z.string().regex(/^[a-f0-9]{64}$/), servers: z.array(z.string()),
})

export async function getAcceptedNativeSkillMcps(input: PluginInput, invocation: { readonly sessionID: string; readonly agent: string }) {
  const state = getNativeSkillState(input)
  if (!state) throw new NativeSkillError("", "Native skill state is unavailable")
  const snapshots = await state.context.experimental.skill.activations({ sessionID: invocation.sessionID })
  return resolveAcceptedSkillMcp(state, invocation, snapshots)
}

export function resolveAcceptedSkillMcp(
  state: NativeSkillState,
  invocation: { readonly sessionID: string; readonly agent: string },
  snapshots: ReadonlyArray<V2SkillSnapshot>,
): ReadonlyArray<{ readonly skill: LoadedSkill; readonly revision: string }> {
  const accepted = new Map<string, { readonly skill: LoadedSkill; readonly revision: string }>()
  for (const snapshot of snapshots) {
    if (snapshot.sessionID !== invocation.sessionID || snapshot.agent !== invocation.agent) continue
    const parsed = Descriptor.safeParse(snapshot.metadata["omo.skill"])
    if (!parsed.success) continue
    const loaded = getNativeLoadedSkill(state, snapshot.skill)
    if (!loaded || (loaded.definition.agent && loaded.definition.agent !== invocation.agent)) continue
    const current = nativeSkillDescriptor(loaded, snapshot.skill)
    if (parsed.data.id !== current.id || parsed.data.name !== current.name || parsed.data.source !== current.source ||
      parsed.data.revision !== current.revision || JSON.stringify(parsed.data.servers) !== JSON.stringify(current.servers)) continue
    accepted.set(current.id, {
      skill: loaded,
      revision: createHash("sha256").update(JSON.stringify([snapshot.revision, current.revision])).digest("hex"),
    })
  }
  return [...accepted.values()]
}
