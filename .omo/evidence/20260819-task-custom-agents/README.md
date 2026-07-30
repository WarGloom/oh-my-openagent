# Custom project agents in `task()`

## What was tested

An isolated real `opencode run --format json` loaded the candidate OMO bundle from this worktree. The sandbox contained a project-defined `.opencode/agents/project-worker.md` agent and a local OpenAI Responses-compatible provider. The parent model called `task(subagent_type="project-worker")`; the child returned `CUSTOM_AGENT_OK`, and the parent returned `PARENT_OK`.

## What was observed

- The provider received the real `task` tool schema with `subagent_type.type = "string"` and no enum.
- The task completed with `Agent: project-worker` and metadata naming `requested_subagent_type: project-worker`.
- The isolated OpenCode database recorded one child session whose agent was exactly `project-worker`.
- The host OpenCode database contained 7,200 sessions before and after the run.
- The sandbox and local provider were stopped and removed by the runner's exit trap.

## Why this is enough

The run exercises the rebuilt plugin through OpenCode's real CLI, tool schema serialization, provider tool call, project-agent discovery, OMO runtime resolver, child-session creation, and parent continuation. It proves the previously unreachable runtime resolver now receives a custom project-agent name without weakening its existing mode, visibility, coordinator, or permission checks.

## Verification

- `bun test packages/omo-opencode/src/tools/delegate-task/task-schema.test.ts`: 5 passed.
- `bun test packages/omo-opencode/src/tools/delegate-task/zauc-mocks-subagent-resolver/subagent-resolver.test.ts`: 63 passed.
- `bun run typecheck`: passed.
- `bun run build`: passed.
- `/home/nikita/work/Projects/ai/op/build.sh`: passed and installed OpenCode 1.18.18-dev.
- Full `bun test packages/omo-opencode/src/tools/delegate-task`: 490 passed, with 10 pre-existing failures and one parse error in untouched tests. None intersects the changed schema branch or project-agent resolver test.

## Artifacts

- `opencode-run.jsonl`: six structured OpenCode run events.
- `provider-requests.jsonl`: four metadata-only provider request records.
- `qa-result.json`: machine-readable verdict, child identity, schema shape, and host-database isolation counts.

Raw request bodies, headers, credentials, environment values, and sandbox paths are not retained.
