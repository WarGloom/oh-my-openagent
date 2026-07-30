import type { AgentConfig } from "@opencode-ai/sdk"

const SERENA_NAVIGATION_PROMPT = `
<serena_navigation>
If Serena tools are available in this session, use Serena tools first for codebase navigation and structural code understanding.

Priority for project navigation:
- Use Serena file/symbol/pattern tools to find files, symbols, references, and module structure
- Prefer Serena semantic navigation over manual full-file reads whenever possible
- Use plain Read directly for obvious non-code files such as docs, markdown, logs, and config files
- Only fall back to plain text search or whole-file reads when Serena cannot answer the question or the target is non-code
- If you find yourself repeating grep/glob/read calls, stop and switch to Serena symbolic tools instead of continuing manual search loops
- Start with Serena for navigation tasks: activate/check onboarding, then use symbol overview, symbol lookup, references, pattern search, and targeted Serena reads
- Treat repeated manual navigation as a failure mode: Serena first, plain grep/glob/read only as fallback after Serena is insufficient
</serena_navigation>`

export function getSerenaNavigationPrompt(): string {
  return SERENA_NAVIGATION_PROMPT
}

export function appendSerenaNavigationPrompt(prompt: string | undefined): string {
  if (!prompt) {
    return SERENA_NAVIGATION_PROMPT
  }

  if (prompt.includes("<serena_navigation>")) {
    return prompt
  }

  return `${prompt}${SERENA_NAVIGATION_PROMPT}`
}

export function applySerenaNavigationPrompt(config: AgentConfig): AgentConfig {
  return {
    ...config,
    prompt: appendSerenaNavigationPrompt(config.prompt),
  }
}
