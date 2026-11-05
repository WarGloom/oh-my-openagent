import { z } from "zod"
import type { V2ToolEditor, V2ToolResult } from "./context-types"
import type { V2SkillInfo } from "./native-skill-types"
import type { NativeSkillState } from "./native-skill-state"
import { NativeSkillError } from "./native-skill-expansion"

const Input = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  user_message: z.string().optional(),
}).refine((input) => input.id !== undefined || input.name !== undefined, "A skill id or name is required")

export function resolveNativeSkill(skills: ReadonlyArray<V2SkillInfo>, name: string): V2SkillInfo {
  const exact = skills.find((skill) => skill.id === name)
  if (exact) return exact
  const normalized = name.replace(/^\//, "").toLowerCase()
  const full = skills.filter((skill) => skill.name.toLowerCase() === normalized)
  const matches = full.length > 0 ? full : skills.filter((skill) => skill.name.includes("/") && skill.name.split("/").at(-1)?.toLowerCase() === normalized)
  if (matches.length === 1 && matches[0]) return matches[0]
  throw new NativeSkillError(name, `Skill "${name}" ${matches.length > 1 ? "is ambiguous" : "was not found"}`)
}

export function decorateNativeSkillTool(editor: V2ToolEditor, state: NativeSkillState): void {
  editor.update("skill", (tool) => {
    const execute = tool.execute
    tool.input = Input
    tool.execute = async (input, context): Promise<V2ToolResult> => {
      const args = Input.parse(input)
      const skills = (await state.context.skill.list()).data
      const skill = resolveNativeSkill(skills, args.id ?? args.name ?? "")
      return execute({ id: skill.id, ...(args.user_message === undefined ? {} : { arguments: args.user_message }) }, context)
    }
  })
}
