import type { V2Listed, V2Registration } from "./context-types"

export type V2SkillJson = null | boolean | number | string | V2SkillJson[] | { [key: string]: V2SkillJson }

export type V2SkillActivation = {
  readonly activationID: string
  readonly sessionID: string
  readonly agent: string
  readonly source:
    | { readonly kind: "session"; readonly messageID: string }
    | { readonly kind: "prompt"; readonly messageID: string; readonly selectionIndex: number }
    | { readonly kind: "tool"; readonly messageID: string; readonly callID: string }
  readonly skill: V2SkillInfo
  readonly arguments?: string
  content: string
  metadata: Record<string, V2SkillJson>
  decision: { readonly allow: true } | { readonly allow: false; readonly reason: string }
}

export type V2SkillSnapshot = {
  readonly activationID: string
  readonly sessionID: string
  readonly agent: string
  readonly source: V2SkillActivation["source"]
  readonly skill: V2SkillInfo
  readonly arguments?: string
  readonly revision: string
  readonly content: string
  readonly metadata: Readonly<Record<string, V2SkillJson>>
}

export type V2ExperimentalSkillDomain = {
  readonly activate: (input: {
    readonly sessionID: string
    readonly activationID?: string
    readonly messageID?: string
    readonly skill: string
    readonly arguments?: string
    readonly resume?: boolean
  }) => Promise<V2SkillSnapshot>
  readonly activations: (input: { readonly sessionID: string }) => Promise<ReadonlyArray<V2SkillSnapshot>>
  readonly activation: (input: { readonly sessionID: string; readonly skillID: string }) => Promise<V2SkillSnapshot>
}

export type V2SubagentSkillAdmission = {
  readonly admissionID: string
  readonly promptID?: string
  readonly skills: ReadonlyArray<{ readonly skill: string; readonly arguments?: string }>
}

export type V2SubagentSkillsDomain = {
  readonly acceptSkills: (input: V2SubagentSkillAdmission) => Promise<ReadonlyArray<V2SkillSnapshot>>
}

export type V2SkillInfo = {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly content: string
  readonly description?: string
  readonly autoinvoke?: boolean
}

export type V2SkillEditor = {
  readonly list: () => ReadonlyArray<V2SkillInfo>
  readonly get: (id: string) => V2SkillInfo | undefined
  readonly add: (skill: V2SkillInfo) => void
  readonly update: (
    id: string,
    update: (skill: { -readonly [Key in keyof V2SkillInfo]: V2SkillInfo[Key] }) => void,
  ) => void
  readonly remove: (id: string) => void
}

export type V2SkillDomain = {
  readonly list: () => Promise<V2Listed<V2SkillInfo>>
  readonly transform: (callback: (editor: V2SkillEditor) => void) => Promise<V2Registration>
  readonly reload: () => Promise<void>
  readonly hook: (
    name: "experimental.activate",
    callback: (event: V2SkillActivation) => Promise<void> | void,
  ) => Promise<V2Registration>
}
