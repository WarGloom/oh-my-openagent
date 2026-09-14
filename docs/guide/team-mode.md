# Team Mode

Parallel multi-agent coordination for omo, modeled after Claude Code's experimental Agent Teams.

This guide describes Team Mode in the OpenCode edition. Senpi member rules are listed separately below; they do not change the OpenCode tool API or eligibility rules.

## Status

OFF by default. Enable via JSONC config.

## When to use

- Parallel exploration with bounded coordination.
- Long-running multi-step refactors split across specialised agents.
- Research + implementation pipelines that need shared task lists.

Do not use team mode for independent one-off searches, read-only audits, or fact gathering where workers do not need shared state or peer messaging. Use parallel background `task(..., run_in_background=true, load_skills=[])` subagents for that. Team mode is for coordinated work with shared tasks, mailbox state, lifecycle closure, worktrees, or tmux visibility.

## Enable

Add to the `[opencode]` block of `~/.omo/omo.jsonc` (user) or `.omo/omo.jsonc` (project):

```jsonc
{
  "team_mode": {
    "enabled": true,
    "max_parallel_members": 4,
    "max_members": 8,
    "tmux_visualization": false
  }
}
```

After enabling, restart opencode. The 12 `team_*` tools become available.

> Bug-fix note: a fresh-install regression test covers this minimal config and startup logs the resolved `team_mode` state plus team tool count (`[tool-registry] Built tool registry`). If the tools still do not appear after restart, inspect `oh-my-opencode.log` for the loaded config path and `[tool-registry] Built tool registry` entry.

## Config schema (11 fields)

All fields live under `team_mode`:

- `enabled` (boolean, default `false`)
- `tmux_visualization` (boolean, default `false`)
- `max_parallel_members` (int, `1..8`, default `4`)
- `max_members` (int, `1..16`, default `8`)
- `max_messages_per_run` (int, `>=1`, default `10000`)
- `max_wall_clock_minutes` (int, `>=1`, default `120`)
- `max_member_turns` (int, `>=1`, default `500`)
- `base_dir` (optional string; default resolves to `~/.omo`)
- `message_payload_max_bytes` (int, `>=1024`, default `32768`)
- `recipient_unread_max_bytes` (int, `>=1024`, default `262144`)
- `mailbox_poll_interval_ms` (int, `>=500`, default `3000`)

## Define a team

Team specs live under `~/.omo/teams/{name}/config.json` (user scope) or `<project>/.omo/teams/{name}/config.json` (project scope):

For one-off inline `team_create({ inline_spec })` calls, prefer the runtime-safe category-member shorthand and omit unused optional keys:

```json
{
  "name": "project-analysis-team",
  "members": [
    { "name": "structure-analyst", "category": "quick", "prompt": "Analyze project structure and report concrete files." },
    { "name": "quality-analyst", "category": "quick", "prompt": "Analyze tests, CI/CD, build scripts, and conventions." }
  ]
}
```

Do not pass empty strings for unused fields such as `teamName`, `kind`, `category`, or `subagent_type`. Omit unused keys entirely. `team_create` always binds lead ownership to the calling session; callers cannot override the lead session ID.

Declared team config files can use the full canonical discriminated member schema:

```json
{
  "name": "ccapi-explorers",
  "description": "Explore the ccapi project structure.",
  "members": [
    { "kind": "category", "name": "scout-1", "category": "deep-low", "prompt": "Scout the source directory for auth patterns." },
    { "kind": "category", "name": "scout-2", "category": "quick", "prompt": "Scout tests for auth coverage." },
    { "kind": "subagent_type", "name": "auditor", "subagent_type": "my-security-auditor", "prompt": "Audit the auth findings the scouts report." }
  ]
}
```

When both scopes define the same team name, project scope wins.

`version` and `createdAt` are optional in config files; the loader fills them automatically. An eligible caller's session is reused for the lead; for an unregistered custom caller, an explicitly declared eligible lead is spawned separately. `team_create` also accepts the same shape inline: `{ name, members: [{ name, category|subagent_type, prompt? }] }`. Arrays with more than eight members require an explicit lead: set `leadAgentId` to an existing member name, supply `lead: {...}`, or mark a member with `isLead: true`. A separate lead plus 15 workers fills the maximum roster of 16. For existing smaller arrays, implicit lead behavior is unchanged: an eligible caller is prepended below eight members; at exactly eight, the first member represents the caller lead rather than a separately spawned worker.

## Member kinds

- **`kind: "subagent_type"`**: direct built-in or project-defined agent. Built-in examples include `atlas`, `sisyphus`, `sisyphus-junior`, and `hephaestus`. `prompt` optional.
- **`kind: "category"`** — routed through `sisyphus-junior` with the chosen category model. `prompt` REQUIRED.

Inline category shorthand `{ "name": "worker", "category": "quick", "prompt": "..." }` is preferred for ad-hoc teams. If you use canonical `kind`, make the fields match the kind and omit unrelated keys.

### Project-defined agent members

Set `subagent_type` to the exact final name of an agent defined in the current project's `.opencode/agents/*.md`. Project-defined agents can be members, not team leads.

OMO checks config-time provenance against the nearest registered snapshot for the active directory or one of its lexical ancestors, so descendant and member-worktree directories can use a project snapshot recorded at the project root. That nearest snapshot is authoritative: if it is empty or does not contain the agent, resolution fails closed without consulting older ancestors. Sibling paths do not qualify.

The final agent must be visible, non-native, use mode `subagent` or `all`, and already agree with the Team launcher permissions: unconditionally allow `call_omo_agent`, `team_send_message`, `team_task_list`, `team_task_get`, `team_task_update`, and `team_status`; and define an unconditional allow or deny for `task`, `question`, and every agent-specific launcher deny. Member launch always narrows those disabled tools to deny, so a project agent may keep `task: allow` for direct primary-agent use without enabling nested Team delegation. OMO uses the active configuration for that project directory as-is: it does not add prompts, models, fallbacks, or permissions. A same-name definition from another later source does not qualify; the agent must come from the current project's file.

## Eligible agents

For OpenCode:

- **Eligible built-ins:** `sisyphus`, `atlas`, `sisyphus-junior`.
- **Conditional:** `hephaestus` (registry verdict `conditional`; OpenCode still sets `teammate: "allow"` in `tool-config-handler.ts`).
- **Hard-reject:** `oracle`, `librarian`, `explore`, `multimodal-looker`, `metis`, `momus`, `prometheus`.

Hard-reject agents fail TeamSpec parsing because they cannot write mailbox state. Use the `task` tool for those agents; its implementation module is named `delegate-task`. Project-defined members must meet the requirements above.

### Senpi member rules

The following rules apply only to Senpi, not the OpenCode edition described in the rest of this guide. See [Senpi task delegation and teams](senpi-task.md).

- **`kind: "category"`**: routed to the category worker, a fresh worker session configured by the category's model and skills. `prompt` REQUIRED. Unknown categories fail with `UNRESOLVABLE_CATEGORY` and the error lists the available ones.
- **`kind: "subagent_type"`** (alias `"agent"`): a user-defined agent from `omo.json` `agents`, invoked directly. `prompt` optional. The kind is inferred from whichever field you set, so you can omit it.

- **Eligible:** any resolvable category, and any user-defined agent.
- **Rejected at parse:** the curated read-only agents (`explore`, `librarian`, `plan-consultant`, `plan-reviewer`) and the ulw-loop reviewer trio (`omo-native-code-reviewer`, `omo-native-qa-executor`, `omo-native-gate-reviewer`).

The curated agents are read-only and in-process, so they can't write mailbox state. The reviewer trio is rejected because process-mode members drop reviewer instructions and tool allowlists. Route both groups through the `task` tool instead (`packages/senpi-task/src/team/member-validator.ts`).

## Lifecycle

1. `team_create` — spawns team and member sessions.
2. Lead delegates work via `team_send_message`, `team_task_create`. Mid-run, the lead can add one member to the active run with `team_add_member({ teamRunId, member })`; it counts against `max_members` and leaves existing members, tasks, and mailboxes intact.
3. Members claim tasks (`team_task_update` with `status: "claimed"`), report back via `team_send_message`.
4. `team_shutdown_request` → member or lead acks via `team_approve_shutdown` / `team_reject_shutdown`.
5. `team_delete` — removes runtime state, worktrees, optional tmux layout.

Closure is the lead's responsibility, not the user's. Do NOT close a team just because every task row is terminal: close only once every member's results have been received AND accepted and no follow-up work remains. A task can be marked terminal before its result actually reaches and is accepted by the lead. When follow-up work is expected, extend the active run with `team_add_member` instead of closing.

## 13 tools

| Tool | Purpose |
|------|---------|
| `team_create` | Spawn a team. |
| `team_add_member` | Add one member to an active run (lead only). Returns `{ teamRunId, memberName, sessionId, status }` once the member's durable row, inbox, and registry entry are ready. |
| `team_delete` | Tear down (lead only; rejects active members unless `force: true`). |
| `team_shutdown_request` | Lead asks a member to wrap up. |
| `team_approve_shutdown` / `team_reject_shutdown` | Member or lead responds. |
| `team_send_message` | Peer-to-peer mailbox; lead-only broadcast. |
| `team_task_create` / `_list` / `_update` / `_get` | Shared task list. |
| `team_status` | Aggregate runtime view. |
| `team_list` | Declared + active teams. |

## Bounds (defaults)

- 8 members by default, configurable up to 16 including the lead; spawn fan-out defaults to 4.
- `max_members` (default 8) is the roster cap; it counts every row including the lead and finished members. `team_add_member` is rejected at capacity, and finished members never free their slot for the life of the run. Set `team_mode.max_members` to `16` to opt in for new runs only; existing runs keep their original bounds. `max_parallel_members` (default 4, maximum 8) stays a spawn fan-out limit, not a live-concurrency or roster cap. Provider and background-task concurrency limits are unchanged.
- 32 KB per message body, 256 KB per recipient unread.
- 10 000 messages per run, 120 minutes wall clock, 500 turns per member.

## Worktrees (optional per member)

Add `"worktreePath": "../wt-scout"` to a member entry. Path is filesystem-relative or absolute; bare branch names are rejected. Requires `git`.

## tmux visualization (optional)

Set `tmux_visualization: true`. Requires running inside a tmux session and tmux on PATH. Failures are isolated - a missing tmux never blocks team creation.

When enabled, each member gets a dedicated tmux pane attached to that member's session via `opencode attach`. The pane runs the full interactive opencode TUI for the member so you can watch streaming output in real time. Panes start in each member worktree when configured, otherwise `process.cwd()`.

`team_delete` closes the panes and tears down the team layout. Per-member shutdown closes just that pane and rebalances the remaining layout.

## What team mode does NOT do

- No nested teams (members cannot call `team_create`).
- No synchronous reply waits (`team_send_message` is fire-and-forget).
- Members are asked not to spawn further children (member guidance prompt); the `task` tool is not budget-gated to 0. Nested `team_create` is denied.
- `team_delete` rejects active members unless `force: true`.

## Diagnostics

`bunx oh-my-openagent doctor` includes a `team-mode` check showing tmux/git availability, declared team count, and active runtime dirs.

## Storage layout

```
~/.omo/
├── teams/{name}/config.json                      # declared specs
└── runtime/{teamRunId}/
    ├── state.json                                # durable runtime state
    ├── inboxes/{member}/{uuid}.json              # mailbox (atomic per-message files)
    ├── inboxes/{member}/.delivering-{uuid}.json  # transient live-delivery reservation
    ├── inboxes/{member}/processed/               # acked messages
    ├── tasks/{id}.json                           # shared task list
    ├── tasks/claims/                             # task claim records
    └── tasks/.highwatermark                      # tasklist id allocator
```

`.delivering-{uuid}.json` files exist only while a message is being live-delivered via `promptAsync`. They are committed to `processed/` on delivery success, released back to `{uuid}.json` on failure, or reclaimed on team resume if stranded by a crash (10 minute TTL). `listUnreadMessages` ignores dotfile entries so the fallback poll never double-injects a reserved message.

## Reference

Implementation notes: `packages/omo-opencode/src/features/team-mode/AGENTS.md` and `packages/team-core/AGENTS.md`.
