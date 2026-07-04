import { join } from "node:path";
import { OPENCODE_STORAGE } from "../../shared";
export const AGENT_USAGE_REMINDER_STORAGE = join(
  OPENCODE_STORAGE,
  "agent-usage-reminder",
);

export const BASH_TOOLS = new Set([
  "bash",
  "mcp__oc__bash",
]);

export const BASH_CALL_THRESHOLD = 3;

export const BASH_REMINDER_MESSAGE = `
[Agent Usage Reminder — Multi-Step Workflow Detected]

You've run ${BASH_CALL_THRESHOLD}+ bash commands directly without spawning any agents.
Multi-step workflows (git operations, builds, tests, deployments) should be delegated.

RECOMMENDED: Delegate to background agents instead:

\`\`\`
// Parallel execution across repos/commands
task(subagent_type="explore", load_skills=[], run_in_background=true,
  prompt="Run typecheck and report results")

task(category="deep", load_skills=[], run_in_background=true,
  prompt="Perform git sync: fetch upstream, merge dev, resolve conflicts")
\`\`\`

WHY:
- Agents run in parallel — multiple repos/commands simultaneously
- Context window stays clean in the main session
- Failures are isolated per agent, not mixed into your main thread

If this bash call is a simple one-off, ignore this reminder.
`;

// All tool names normalized to lowercase for case-insensitive matching
export const TARGET_TOOLS = new Set([
  "grep",
  "safe_grep",
  "glob",
  "safe_glob",
  "webfetch",
  "context7_resolve-library-id",
  "context7_query-docs",
  "websearch_web_search_exa",
  "context7_get-library-docs",
  "grep_app_searchgithub",
]);

export const AGENT_TOOLS = new Set([
  "task",
  "call_omo_agent",
  "task",
]);

export const REMINDER_MESSAGE = `
[Agent Usage Reminder]

You called a search/fetch tool directly without leveraging specialized agents.

RECOMMENDED: Use task with explore/librarian agents for better results:

\`\`\`
// Parallel exploration - fire multiple agents simultaneously
task(subagent_type="explore", load_skills=[], prompt="Find all files matching pattern X")
task(subagent_type="explore", load_skills=[], prompt="Search for implementation of Y")
task(subagent_type="librarian", load_skills=[], prompt="Lookup documentation for Z")

// Then continue your work while they run in background
// System will notify you when each completes
\`\`\`

WHY:
- Agents can perform deeper, more thorough searches
- Background tasks run in parallel, saving time
- Specialized agents have domain expertise
- Reduces context window usage in main session

ALWAYS prefer: Multiple parallel task calls > Direct tool calls
`;
