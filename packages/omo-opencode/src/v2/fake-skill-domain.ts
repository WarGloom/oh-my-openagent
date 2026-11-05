import type { V2ExperimentalSkillDomain, V2SkillActivation, V2SkillDomain, V2SkillEditor, V2SkillInfo, V2SkillSnapshot } from "./native-skill-types"
import type { V2PermissionDomain } from "./context-types"

export function createFakeSkillActivations(options: {
  readonly domain: ReturnType<typeof createFakeSkillDomain>
  readonly permission: V2PermissionDomain
  readonly snapshots: ReadonlyArray<V2SkillSnapshot>
  readonly agent: string
}): V2ExperimentalSkillDomain {
  const accepted = new Map(options.snapshots.map((snapshot) => [snapshot.activationID, snapshot]))
  let sequence = 0
  return {
    activations: async ({ sessionID }) => [...accepted.values()].filter((snapshot) => snapshot.sessionID === sessionID),
    activation: async ({ sessionID, skillID }) => {
      const snapshot = [...accepted.values()].findLast((entry) => entry.sessionID === sessionID && entry.skill.id === skillID)
      if (!snapshot) throw new Error("Skill activation was not accepted")
      return snapshot
    },
    activate: async (input) => {
      const activationID = input.activationID ?? `activation-${++sequence}`
      const previous = accepted.get(activationID)
      if (previous) {
        if (previous.sessionID !== input.sessionID) throw new Error("Skill activation belongs to another session")
        return previous
      }
      const skill = (await options.domain.list()).data.find((entry) => entry.id === input.skill)
      if (!skill) throw new Error("Skill not found")
      await options.permission.assert({ sessionID: input.sessionID, agent: options.agent, action: "skill", resources: [skill.id] })
      const event = await options.domain.activate({
        activationID, sessionID: input.sessionID, agent: options.agent, source: { kind: "session", messageID: input.messageID ?? activationID },
        skill, arguments: input.arguments, content: skill.content, metadata: {}, decision: { allow: true },
      })
      if (!event.decision.allow) throw new Error(event.decision.reason)
      const snapshot: V2SkillSnapshot = structuredClone({ ...event, revision: `registry-${skill.content}` })
      accepted.set(activationID, snapshot)
      return snapshot
    },
  }
}

export function createFakeSkillDomain(base: ReadonlyArray<V2SkillInfo> = []): V2SkillDomain & { readonly activate: (event: V2SkillActivation) => Promise<V2SkillActivation> } {
  const transforms = new Set<(editor: V2SkillEditor) => void>()
  const hooks = new Set<(event: V2SkillActivation) => Promise<void> | void>()
  let skills = new Map<string, V2SkillInfo>()
  const rebuild = () => {
    skills = new Map(base.map((skill) => [skill.id, { ...skill }]))
    const editor: V2SkillEditor = {
      list: () => [...skills.values()],
      get: (id) => skills.get(id),
      add: (skill) => { skills.set(skill.id, { ...skill }) },
      update: (id, update) => {
        const skill = skills.get(id)
        if (!skill) return
        const draft = { ...skill }
        update(draft)
        skills.set(id, { ...draft, id })
      },
      remove: (id) => { skills.delete(id) },
    }
    for (const transform of transforms) transform(editor)
  }
  rebuild()
  return {
    list: async () => ({ data: [...skills.values()] }),
    reload: async () => { rebuild() },
    hook: async (_name, callback) => {
      hooks.add(callback)
      return { dispose: async () => { hooks.delete(callback) } }
    },
    activate: async (event) => {
      for (const hook of hooks) {
        await hook(event)
        if (!event.decision.allow) break
      }
      return event
    },
    transform: async (transform) => {
      transforms.add(transform)
      rebuild()
      return { dispose: async () => { transforms.delete(transform); rebuild() } }
    },
  }
}
