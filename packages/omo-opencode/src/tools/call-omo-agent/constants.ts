export const ALLOWED_AGENTS = [
  "explore",
  "librarian",
] as const

export const CALL_OMO_AGENT_DESCRIPTION = `Spawn explore/librarian agent. run_in_background REQUIRED (true=async with task_id, false=sync).

Allowed agents:
{agents}

Other built-in agents, custom agents, and task categories are intentionally not supported by this tool.

Pass \`session_id=<id>\` to continue previous agent with full context. Nested subagent depth is tracked automatically and blocked past the configured limit. Prompts MUST be in English, with normal words and spaces and exact identifiers. Give a bounded research question, relevant evidence, constraints, and expected result. Inspect the result/error delivered in the native completion notification. Use \`background_output\` only for missing/truncated output or transcript/diagnostic detail.`
