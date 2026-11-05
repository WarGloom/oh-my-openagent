import { dirname } from "node:path"
import type { LoadedSkill } from "../features/opencode-skill-loader"
import { injectGitMasterConfig } from "../features/opencode-skill-loader/skill-content"
import { extractSkillBody } from "../tools/skill/skill-body"
import { formatLoadedCommand } from "../tools/slashcommand/command-output-formatter"
import type { SkillLoadOptions } from "../tools/skill/types"
import type { CommandInfo } from "../tools/slashcommand/types"

export class NativeSkillError extends Error {
  constructor(readonly skill: string, message: string) {
    super(message)
    this.name = "NativeSkillError"
  }
}

export type NativeSkillInvocation = {
  readonly agent: string
  readonly sessionID: string
  readonly arguments?: string
  readonly command?: CommandInfo
  readonly nativeContent?: string
}

export async function expandLoadedSkill(
  skill: LoadedSkill,
  options: SkillLoadOptions,
  invocation: NativeSkillInvocation,
): Promise<{ readonly directory: string; readonly content: string }> {
  if (skill.definition.agent && skill.definition.agent !== invocation.agent) {
    throw new NativeSkillError(skill.name, `Skill "${skill.name}" is restricted to agent "${skill.definition.agent}"`)
  }
  const directory = skill.path ? dirname(skill.path) : skill.resolvedPath ?? options.directory
  const command = invocation.command
  const body = command
    ? await formatLoadedCommand(command, invocation.arguments)
    : invocation.nativeContent ?? await extractSkillBody(skill)
  const configured = skill.name === "git-master" ? injectGitMasterConfig(body, options.gitMasterConfig) : body
  const content = invocation.arguments === undefined || command ? configured : configured
    .replace(/\$\{user_message\}|\$ARGUMENTS/g, () => invocation.arguments ?? "")
  const servers = Object.keys(skill.mcpConfig ?? {})
  return {
    directory,
    content: servers.length === 0 ? content : `${content}\n\nSkill MCP servers: ${servers.join(", ")}. Use skill_mcp to invoke accepted skill servers.`,
  }
}
