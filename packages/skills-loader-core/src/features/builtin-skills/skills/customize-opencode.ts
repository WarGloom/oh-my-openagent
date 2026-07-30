import type { BuiltinSkill } from "../types"

const TEMPLATE = `# Customize OpenCode

Use this skill only when editing OpenCode or OMO configuration and extension surfaces:

- \`opencode.json\`, \`opencode.jsonc\`, or files under \`.opencode/\`
- files under \`~/.config/opencode/\`
- OpenCode agents, subagents, skills, plugins, MCP servers, permission rules, and commands

Do not use this skill for ordinary application code. If the user is asking about their app, library, tests, frontend, backend, or infrastructure rather than OpenCode itself, ignore this skill.

## Rules

- Read the existing config or skill file before editing it.
- Preserve JSONC comments, trailing commas, and existing key ordering where practical.
- Keep names stable; changing an agent, skill, command, or MCP name can break user prompts and automation.
- Prefer the smallest config change that makes the requested behavior explicit.
- For MCP entries, preserve transport-specific fields and avoid leaking secrets into config files.
- For permission rules, choose the narrowest pattern that grants the requested capability.
- For skills and commands, write trigger descriptions that are specific enough to avoid accidental activation.

## OpenCode-Specific Checks

- Confirm whether the file is project-scoped (\`.opencode/\`) or user-scoped (\`~/.config/opencode/\`) before writing.
- Do not edit user-scoped config when the task only needs project behavior.
- Do not edit project-scoped config when the user explicitly asked for a global OpenCode setting.
- After changes, verify with the smallest relevant command or test available in the repo.
`

export const customizeOpencodeSkill: BuiltinSkill = {
	name: "customize-opencode",
	description:
		"Use when editing OpenCode configuration, .opencode files, agents, skills, plugins, MCP servers, commands, or permission rules. Do not use for ordinary application code.",
	template: TEMPLATE,
}
