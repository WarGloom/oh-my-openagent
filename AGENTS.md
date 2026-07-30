# oh-my-opencode — OpenCode Plugin

> **HOLD THE FUCK UP. THIS ENTIRE GODDAMN CODEBASE IS BEING RIPPED APART AND REBUILT RIGHT NOW. A MASSIVE MULTI-HARNESS AGENT OS REFACTOR IS IN PROGRESS — WE ARE RESTRUCTURING EVERYTHING TO SUPPORT MULTIPLE AGENT HARNESSES (OPENCODE, CODEX, PI, AND OTHERS). DO NOT TRUST THE STRUCTURE BELOW AS STABLE. READ THE [ROADMAP](./ROADMAP.md) BEFORE YOU TOUCH ANYTHING OR SO HELP ME GOD.**

**Generated:** 2026-08-24 | **Source snapshot:** f3642fcda | **Branch:** initdeep-refresh-20260824 | **Release:** v5.0.0-beta.18

## STOP. QA IS MANDATORY. NON-NEGOTIABLE. EVERY SINGLE TIME YOU TOUCH AN OPENCODE-, CODEX-, OR SENPI-CONNECTED COMPONENT.

> **IF YOUR CHANGE TOUCHES ANYTHING WIRED INTO OPENCODE, INTO THE CODEX LIGHT EDITION, OR INTO THE SENPI ADAPTER, YOU MUST QA IT. ALWAYS. EVERY SINGLE TIME. NO EXCEPTIONS. THERE IS NO "TOO SMALL TO SKIP". THERE IS NO "IT OBVIOUSLY WORKS".**

**"It typechecks" is NOT QA. "`bun test` is green" is NOT QA.** YOU MUST DRIVE THE REAL HARNESS, and then **YOU MUST WRITE THE EVIDENCE TO DISK.** If there is no evidence file, **the QA DID NOT HAPPEN**, and **YOU ARE NOT ALLOWED TO COMMIT OR PUSH.**

This is repeated on purpose, because it is the single most ignored rule in this repo. **CHANGE A HOOK, A TOOL, AN AGENT, A FEATURE, A CONFIG SCHEMA, AN MCP, A CLI COMMAND, AN INSTALLER, A PROMPT, OR ANYTHING ELSE THAT REACHES OPENCODE, CODEX, OR SENPI, THEN: RUN QA, THEN RECORD EVIDENCE.** Always. Every time. No exceptions.

### OPENCODE side (`packages/omo-opencode/`): ALWAYS run the `opencode-qa` skill

1. **ALWAYS RUN THE `opencode-qa` SKILL** (`.agents/skills/opencode-qa/`) to map the EXPECTED IMPACT and the FULL CHANGE SCOPE of your edit BEFORE and AFTER. Pick the right case: CLI (`opencode run --format json`), server + SSE hook proof, TUI smoke, or DB inspection.
2. **ISOLATE EVERYTHING.** Any QA that SPAWNS opencode MUST run in an isolated XDG sandbox (`XDG_DATA_HOME` / `XDG_CONFIG_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` pointed at temp dirs). The bundled scripts already do this. **NEVER pollute the real `~/.local/share/opencode/opencode.db`.** PROVE isolation by comparing `SELECT count(*) FROM session` before and after.
3. **USE tmux** for the TUI smoke (`scripts/tui-smoke.sh`) and for any interactive driving. tmux is for SMOKE (did it boot, render, accept a key); assert REAL behavior via `opencode run --format json` or the server API + SSE.
4. **PROVE THE HOOK FIRED.** If you changed a lifecycle hook, prove the matching event hit the wire (`scripts/sse-hook-probe.sh --event <name>`). Seeing the event proves the hook would fire.

### CODEX side (`packages/omo-codex/`): ALWAYS run the `codex-qa` skill

1. **ALWAYS RUN THE `codex-qa` SKILL** (`.agents/skills/codex-qa/`) to map the EXPECTED IMPACT and the FULL CHANGE SCOPE of your edit BEFORE and AFTER. It exercises ONLY our plugin in strict isolation: an isolated `CODEX_HOME` plus a local mock model with no real API call.
2. **PROVE THE HOOK FIRED, FIRST-PARTY.** The skill drives the real `codex app-server` and asserts `hook/started` and `hook/completed` notifications for our components. Deterministic checks include `scripts/hook-unit-probe.sh`, `scripts/install-verify.sh`, and `scripts/tui-smoke.sh`; each script ships with a `--self-test`.
3. **RUN THE CODEX GATE:** `bun run test:codex`. This is the hermetic unit gate; it does not prove a live session.
4. **CONFIRM THE REAL `~/.codex/config.toml` WAS NOT TOUCHED.**

### SENPI side (`packages/omo-senpi/`, `packages/senpi-task/`): ALWAYS run the `senpi-qa` skill

1. **ALWAYS RUN THE `senpi-qa` SKILL** (`.agents/skills/senpi-qa/`) to map the expected impact and full change scope before and after.
2. Resolve the evidence directory only with:

   `node .agents/skills/senpi-qa/scripts/resolve-evidence-dir.mjs --repo-root "$(git rev-parse --show-toplevel)" --slug <YYYYMMDD>-<short-slug>`

   It returns a path under `.omo/evidence/omo-senpi-adapter/<slug>/` and rejects traversal, separators, absolute paths, and stray roots.
3. **RUN THE SENPI GATE:** `tsgo --noEmit -p packages/omo-senpi/tsconfig.json` followed by `bun run test:senpi`.
4. **CONFIRM THE REAL `~/.senpi/agent` WAS NOT TOUCHED.** Record the live driver's `realSenpiUntouched` and changed-path fields. A driver reporting `SKIP` because the `senpi` binary is absent is not a pass.

### EVIDENCE: write it under `.omo/evidence/` (local, NEVER committed) or it DID NOT HAPPEN

**WRITE EVERY QA ARTIFACT TO `.omo/evidence/<YYYYMMDD>-<short-slug>/`** (one subfolder per change, keep it ORGANIZED). Live Senpi QA is the one scoped exception: it goes under `.omo/evidence/omo-senpi-adapter/<slug>/`, resolved by the `senpi-qa` skill's script. **THE EVIDENCE FILES STAY LOCAL.** `.omo/evidence/` is gitignored and `script/tracked-evidence-paths-audit.test.ts` fails the build the moment any evidence path is tracked (#8703): never `git add -f` an evidence file, and never invent another capture root inside the worktree (`.qa-evidence/`, `qa-evidence/`, a RED/GREEN `.txt` next to the sources). What reaches the reviewer is the **QA & Evidence section of the PR body**: the four items below, the decisive sanitized excerpt of each capture (the RED failure line, the GREEN pass count, the driver's final JSON, the isolation proof), and one `sha256sum <artifact>` line per local evidence file so the summary is checkable against the file that produced it. For EVERY change you MUST record reviewer-readable plain files locally and summarize them there:
- **WHAT WAS TESTED:** the command or manual action, the surface driven, and the behavior it was meant to prove.
- **WHAT WAS OBSERVED:** before/after behavior, isolation proof, and the artifact path for captured output.
- **WHY IT IS ENOUGH:** how the evidence covers the intended behavior and remaining regression risk.
- **WHAT WAS OMITTED:** redact secrets, environment dumps, tokens, auth headers, and private credentials.

**NO EVIDENCE FILE == NO QA == NO COMMIT == NO PUSH.** ALWAYS. EVERY TIME. NO EXCEPTIONS. **AND AN EVIDENCE FILE INSIDE THE COMMIT == A REJECTED PR.**

## MANDATORY CHANGE-EXECUTION PROTOCOL

The moment a task requires producing a patch that modifies this repository, this protocol applies:

1. **EXPLORE.** MAP the code you are about to touch BEFORE editing a single line: read the real files, trace the call paths, measure the blast radius. NEVER patch from memory.
2. **MAKE A PLAN.** Write the full plan down BEFORE the first edit: every file, every change, the verification for each. NO PLAN ON DISK MEANS YOU DO NOT START.
3. **ADD TODOS IN ULTRA-DETAIL.** Mirror EVERY atomic step of the plan into the todo list: one todo per edit-plus-verification unit. Vague todos like "implement feature" are FORBIDDEN.
4. **MAKE A NEW WORKTREE.** ALL implementation happens in a fresh, task-owned git worktree. NEVER edit the main checkout in place, NEVER hand-commit to `dev`.
5. **MAKE A PR AND WORK UNTIL IT GETS MERGED.** Open a reviewer-readable PR and STAY ON IT until it is MERGED: fix CI, answer review, re-run QA, resolve conflicts via `smart-rebase`. AN UNMERGED PR IS UNFINISHED WORK.
6. **SET A GOAL AND RUN THE ULW LOOP.** Register the goal with binding success criteria and drive the work through the `ulw-loop`: evidence-bound, reproduce-first, real-surface QA. "IT SHOULD WORK" IS NOT EVIDENCE.
7. **MANAGE THE TODO LIST OBSESSIVELY.** Mark a step in progress the instant it begins, done the instant it finishes, append new steps the moment they surface. THE TODO LIST NEVER LAGS REALITY. EVER.

## DEFAULT WORKFLOW

Unless the user explicitly says otherwise, or the task is an urgent hotfix, deliver every change through the `work-with-pr` skill. It uses an isolated worktree, evidence-bound manual QA, a reviewer-readable English PR, and the verification loop.

- **QA is the evidence gate, scoped to what you touched.** A change under `packages/omo-opencode/` MUST run the **`opencode-qa`** skill; a change under `packages/omo-codex/` (lazycodex) MUST run the **`codex-qa`** skill; a change under `packages/omo-senpi/` or `packages/senpi-task/` MUST run the **`senpi-qa`** skill (see the QA section above for each). Run the matching skill, and treat its captured output (written under the gitignored `.omo/evidence/`, summarized in the PR body, never committed) as the QA evidence `work-with-pr` requires. A change touching more than one runs each.
- **Conflicts → `smart-rebase`.** If the worktree branch conflicts with its base, resolve it with the **`smart-rebase`** skill, then re-run the scoped QA. Never hand-resolve by force-pushing shared history.
- **Merge → merge commit, ALWAYS.** Land the PR with a merge commit per **PR MERGE POLICY** below. NEVER squash-merge or rebase-merge, even if a generic workflow, skill, or GitHub default suggests it.

## OVERVIEW

OpenCode plugin extending OpenCode with 11 agents, approximately 54–62 lifecycle hooks, 12–38 registry tools, a three-tier MCP system, Hashline editing, IntentGate keyword detection, Team Mode, Boulder work tracking, configurable agent ordering, and Claude Code compatibility.

The package layering refactor moved the plugin from root `src/` into [`packages/omo-opencode/src/`](packages/omo-opencode/src/AGENTS.md). There is no root `src/`. The adapter tree is an OpenCode-facing shim over Core packages, MCP packages, and sibling adapters.

Build entry: `packages/omo-opencode/src/index.ts`. It delegates to `packages/omo-opencode/src/testing/create-plugin-module.ts`.

The product has two editions:

- **Ultimate:** OMO for OpenCode, `packages/omo-opencode/`.
- **Light:** OMO for Codex CLI, `packages/omo-codex/`.

## STRUCTURE

```text
oh-my-opencode/
├── packages/
│   ├── omo-opencode/       # OpenCode plugin adapter
│   ├── omo-codex/          # Codex CLI light edition
│   ├── omo-senpi/          # Senpi native adapter
│   ├── omo-native/         # omo-ai launcher distribution
│   ├── senpi-task/         # Senpi task engine
│   ├── pi-goal/
│   ├── pi-webfetch/
│   ├── utils/
│   ├── model-core/
│   ├── prompts-core/
│   ├── rules-engine/
│   ├── agents-md-core/
│   ├── comment-checker-core/
│   ├── hashline-core/
│   ├── boulder-state/
│   ├── memory-core/
│   ├── telemetry-core/
│   ├── lsp-core/
│   ├── mcp-stdio-core/
│   ├── tmux-core/
│   ├── claude-code-compat-core/
│   ├── skills-loader-core/
│   ├── mcp-client-core/
│   ├── openclaw-core/
│   ├── team-core/
│   ├── delegate-core/
│   ├── omo-config-core/
│   ├── lsp-tools-mcp/
│   ├── git-bash-mcp/
│   ├── lsp-daemon/
│   ├── ast-grep-mcp/
│   ├── shared-skills/
│   ├── web/
│   └── oh-my-opencode-<os>-<arch>[-variant]/
├── bin/
├── script/
├── scripts/
├── docs/
├── assets/
├── test-support/
├── tests/
├── signatures/
├── postinstall.mjs
├── .opencode/
├── .agents/
└── .omo/
```
oh-my-opencode/                      # workspace root (no root src/ — it moved into packages/omo-opencode)
├── packages/                        # 45 sibling packages across Core/MCP/Skills/Adapters/Platform/Web. See packages/AGENTS.md
│   ├── omo-opencode/                # ★ THE OpenCode plugin adapter (formerly root src/). Build entry: src/index.ts
│   │   ├── src/                     # plugin source and OpenCode-facing adapter shims. Full breakdown → packages/omo-opencode/src/AGENTS.md
│   │       ├── index.ts             # Plugin entry; thin wrapper re-exporting createPluginModule() from src/testing/
│   │       ├── plugin-interface.ts  # 12 OpenCode hook handlers (+2 wired in testing/create-plugin-module.ts)
│   │       ├── create-{managers,tools,hooks}.ts  # 4 managers / ToolRegistry / 5-tier hook composition
│   │       ├── agents/              # 11 agents, 10 createXXXAgent factories (Prometheus special-cased via plugin-handlers/prometheus-agent-config-builder.ts)
│   │       ├── hooks/               # ~54-62 lifecycle hooks (54 base / 61 team / 62 monitor) across 62 dirs (incl. 5 zauc-* mock dirs + shared/ + team-session-events/)
│   │       ├── tools/               # 15 native tool dirs (14 tools + shared/); LSP served via a built-in MCP, ast-grep via the bundled skill
│   │       ├── features/            # 24 feature modules (team-mode, background-agent, skill-mcp-manager, opencode-skill-loader, mcp-oauth, boulder-state, btw-side, tui-sidebar, opengateway-provider, …)
│   │       ├── shared/              # cross-cutting utilities; logger → oh-my-opencode.log in os.tmpdir() (50 MB cap, .1/.2 backups)
│   │       ├── config/              # Zod v4 schema system (36 schema files)
│   │       ├── cli/                 # Commander.js CLI, 12 commands: install(setup), run, doctor, cleanup(uninstall), version, get-local-version, refresh-model-capabilities, boulder, ulw-loop, config (migrate), worktree-sweep, mcp (oauth login/logout/status)
│   │       ├── mcp/                 # 4 built-in MCPs (3 remote + local stdio lsp)
│   │       ├── plugin/ plugin-handlers/  # OpenCode hook handlers + 6-phase config loading pipeline
│   │       ├── openclaw/            # Bidirectional Discord/Telegram/HTTP/shell integration + reply listener daemon
│   │       └── generated/ help/ locales/ testing/ __tests__/  # model-capabilities, CLI help schemas, i18n, test factory, perf benchmarks
│   │   └── scripts/             # standalone codegen (OpenGateway + models.dev → tracked src/features/opengateway-provider/opengateway-models.json). See scripts/AGENTS.md
│   ├── omo-codex/                   # Codex CLI Light edition; vendored Codex plugin `omo` + TS installer + telemetry (`lazycodex` repo/bin identity, `lazycodex-ai` live npm alias)
│   ├── omo-senpi/                   # Senpi native TS extension adapter (local-path Pi package); 18 components incl. task + memory + init-deep-advisor (drives senpi-task + omo-config-core)
│   ├── omo-native/                  # npm `omo-ai` distribution (BETA channel): launcher spawning the pinned senpi engine + `canonicalAgentDir()` (~/.omo/agent)
│   ├── senpi-task/                  # Senpi-coupled task engine: state machine, store, in-process/RPC runners, lifecycle, completion, teams, dependency-frontier DAG engine (src/dag/, largest subsystem); 4 task + 6 lead-team tools (the `dag` tool is registered by omo-senpi)
│   ├── utils/ model-core/ prompts-core/ rules-engine/ agents-md-core/ comment-checker-core/ hashline-core/ boulder-state/ memory-core/ telemetry-core/ lsp-core/ mcp-stdio-core/ tmux-core/ claude-code-compat-core/ skills-loader-core/ mcp-client-core/ openclaw-core/ team-core/ delegate-core/ omo-config-core/   # 20 Core (pure-TS) pkgs
│   ├── lsp-tools-mcp/ git-bash-mcp/ lsp-daemon/ ast-grep-mcp/   # 4 MCP-layer pkgs (stdio); LSP packages consume lsp-core + mcp-stdio-core
│   ├── shared-skills/               # Cross-harness SKILL.md bundle shared by OpenCode + Codex
│   ├── web/                         # Marketing site (Next.js 15 + Cloudflare Workers); own bun.lock; only @/* alias zone in the repo
│   └── oh-my-opencode-<os>-<arch>[-variant]/   # 12 platform launcher packages (bin/ + package.json only; generated, never hand-edited)
├── bin/                             # Platform-detection JS shim; 5 public aliases. See bin/AGENTS.md
├── script/                          # Bun/TS build/publish automation (singular). See script/AGENTS.md
├── scripts/                         # Node ESM third-party-notice helpers. See scripts/AGENTS.md
├── docs/                            # User-facing docs (guide/, reference/, examples/, legal/, manifesto.md, troubleshooting/)
├── assets/                          # Generated config/help schemas. See assets/AGENTS.md
├── test-support/ tests/             # Shared helpers + repo-level integration tests (incl. tests/hashline/ standalone Vercel AI SDK edit-integration suite). See tests/AGENTS.md
├── signatures/                      # CLA signature registry (cla.json)
├── postinstall.mjs                  # Verifies platform binary + OpenCode version
├── test-setup.ts                    # Bun test preload (resets state between tests)
├── .opencode/  .agents/             # Project-scope skills + commands; .agents/ is the authoritative superset (both load, consumers prefer .agents/; new skills go to .agents/ only)
├── .omo/                            # AI agent workspace (rules/, plans/, tasks/, teams/, ulw-loop/, notepads/)
└── .local-ignore/                   # Dev-only test fixtures + PR worktrees (NOT part of the real AGENTS.md hierarchy)
```

## INITIALIZATION FLOW

```text
pluginModule.server(input, options)
  ├─ installAgentSortShim()
  ├─ initConfigContext()
  ├─ logLegacyPluginStartupWarning()
  ├─ migrateLegacyWorkspaceDirectory()
  ├─ detectDuplicateOmoPlugin()
  ├─ detectExternalSkillPlugin()
  ├─ injectServerAuthIntoClient()
  ├─ loadPluginConfig()
  ├─ recordPluginTelemetry()
  ├─ ensureTuiPluginEntry()
  ├─ initLiveServerRoute()
  ├─ setLiveParentWakeRoutingDisabled()
  ├─ warmLiveServerProbe()
  ├─ selectRuntimeSecuritySkills()
  ├─ createRuntimeSkillSourceServer()
  ├─ initI18n()
  ├─ setAgentSortOrder()
  ├─ initializeOpenClaw()
  ├─ checkTeamModeDependencies()
  ├─ startTmuxCheck()
  ├─ createManagers()
  ├─ createTools()
  ├─ createHooks()
  ├─ createPluginInterface()
  └─ createPluginDispose()
```

## OPENCODE HOOK HANDLERS

Twelve handlers are wired in `packages/omo-opencode/src/plugin-interface.ts`; two additional handlers are wired directly in `create-plugin-module.ts`.

| Handler | Hook | Purpose |
|---|---|---|
| `config` | `config` | Provider, components, agents, tools, MCPs, and commands pipeline |
| `tool` | `tool` | Registry tools, gated by configuration |
| `tool.definition` | `tool.definition` | Per-tool definition transforms |
| `chat.message` | `chat.message` | Session setup and keyword detection |
| `chat.params` | `chat.params` | Model parameters, effort, thinking, and fallback |
| `chat.headers` | `chat.headers` | Copilot initiator headers |
| `command.execute.before` | `command.execute.before` | Pre-command guards |
| `event` | `event` | Session lifecycle and runtime fallback |
| `tool.execute.before` | `tool.execute.before` | Rules, write, label, and agent guards |
| `tool.execute.after` | `tool.execute.after` | Output, comment, Hashline, and JSON recovery hooks |
| `experimental.chat.messages.transform` | `experimental.chat.messages.transform` | Context and message transforms |
| `experimental.chat.system.transform` | `experimental.chat.system.transform` | System-message transforms |
| `experimental.session.compacting` | `experimental.session.compacting` | Context and todo preservation |
| `experimental.compaction.autocontinue` | `experimental.compaction.autocontinue` | Resume after compaction |

## TOOL CATALOG

Always-on registry tools include:

`grep`, `glob`, `session_list`, `session_read`, `session_search`, `session_info`, `background_output`, `background_cancel`, `call_omo_agent`, `task`, `skill`, and `skill_mcp`.

Conditional tools include:

- `look_at`
- `interactive_bash`
- `monitor_start`, `monitor_stop`, `monitor_list`, `monitor_output`
- `task_create`, `task_get`, `task_list`, `task_update`
- `edit`
- Team Mode tools
- `create_goal`, `update_goal`, `get_goal`

The eight LSP aliases are served by the built-in LSP MCP and are not registry registrations. Structural search and rewrite are provided by the `ast-grep` skill.

## TEAM MODE

Team Mode is off by default. Enable it with `team_mode.enabled` in `.opencode/oh-my-opencode.jsonc` or user configuration, then restart OpenCode.

Members declared as `kind: "subagent_type"` are direct agents. Members declared as `kind: "category"` are routed through `sisyphus-junior`.

Eligible agents:

- `sisyphus`
- `atlas`
- `sisyphus-junior`

Conditional:

- `hephaestus`, which requires the `teammate: "allow"` permission or a fallback to `sisyphus`.

Rejected for Team Mode:

- `oracle`
- `librarian`
- `explore`
- `multimodal-looker`
- `metis`
- `momus`
- `prometheus`

Team state is stored under `~/.omo/teams/{name}/` or the project `.omo/teams/{name}/` directory:

- `config.json`
- `state.json`
- `mailbox/`
- `tasklist.jsonl`
- `worktrees/`

## CODEX LIGHT EDITION

OMO for Codex is vendored under `packages/omo-codex/`. The marketplace identity is `sisyphuslabs`, the plugin is `omo`, and Codex enables it as `omo@sisyphuslabs`.

The public repository identity is `lazycodex`; the live npm alias is `lazycodex-ai`. `lazycodex` is not the marketplace name.

The Codex adapter includes components for codegraph, comment checking, Git Bash, executor verification, LSP, rules, ULW continuation, Team Mode, telemetry, ultrawork, and the ULW loop. Bootstrap and test-support are intentionally outside the component workspace list.

The installer supports:

```text
bunx oh-my-openagent install --platform=codex
bunx lazycodex-ai install
bunx oh-my-openagent install --platform=both
```

Installation copies the plugin cache, marketplace snapshot, agent TOMLs, runtime wrapper, component CLIs, and configuration changes into isolated Codex locations.

**Member eligibility** (from [`AGENT_ELIGIBILITY_REGISTRY`](packages/omo-opencode/src/features/team-mode/types.ts)):
- `eligible`: sisyphus, atlas, sisyphus-junior
- `conditional`: hephaestus (lacks `teammate: "allow"` permission by default — apply D-36 in `tool-config-handler.ts` or use `subagent_type: "sisyphus"` instead)
- `hard-reject`: oracle, librarian, explore, multimodal-looker, metis, momus, prometheus (rejected at parse — use `task`/delegate-task)

**Storage layout** (`~/.omo/teams/{name}/`): `config.json` (spec), `state.json` (runtime), `mailbox/` (messages), `tasklist.jsonl` (tasks), `worktrees/` (per-member git worktrees).

**Implementation:** [`packages/omo-opencode/src/features/team-mode/`](packages/omo-opencode/src/features/team-mode/AGENTS.md). User docs: [`docs/guide/team-mode.md`](docs/guide/team-mode.md).

## CODEX LIGHT EDITION (omo-codex / lazycodex)

oh-my-openagent ships in two editions of one product. **Ultimate** = this OpenCode plugin (omo for OpenCode = `packages/omo-opencode/`). **Light** = omo for the OpenAI Codex CLI, vendored under [`packages/omo-codex/`](packages/omo-codex/AGENTS.md). "omo in Codex" / "omo for Codex" = **lazycodex**, and the public GitHub repo [`code-yeongyu/lazycodex`](https://github.com/code-yeongyu/lazycodex) is the thin marketplace/distribution layer over `omo-codex`; `lazycodex-ai` is the live npm alias and `lazycodex` is the repository/bin identity.

- **Package:** `@oh-my-opencode/omo-codex` (private, versioned with the repo): "Codex harness adapter. Vendored Codex plugin namespace `omo` + TypeScript installer + telemetry." Plugin bundle pkg = `@sisyphuslabs/omo-codex-plugin`. Reuses `@oh-my-opencode/utils`, shared Core packages, and generated SKILL.md outputs from `@oh-my-opencode/shared-skills` plus component-local skills.
- **Marketplace identity (precision):** Codex sees marketplace `sisyphuslabs`, plugin `omo`, enabled as `omo@sisyphuslabs`. `lazycodex-ai` is the live npm alias; `lazycodex` is the repository/bin identity, never the marketplace name.
- **Alias mechanics:** root `package.json` maps `lazycodex-ai` to `bin/oh-my-opencode.js` (1 of 5 bin aliases: `oh-my-opencode`, `oh-my-openagent`, `omo`, `lazycodex`, `lazycodex-ai`, all the same CLI launcher). `bunx lazycodex-ai install` is exactly `bunx oh-my-openagent install --platform=codex`. Routing: `packages/omo-opencode/src/cli/cli-program.ts` (`lazycodex`/`lazycodex-ai` default platform to codex), `bin/platform.js` (both resolve the `oh-my-openagent` platform family). `packages/omo-opencode/src/cli/star-request.ts` stars both repos.
- **Disambiguation:** `publish.yml` republishes this repo's CLI under the live npm alias `lazycodex-ai` (name/version rewrite). Bare `lazycodex` is only the `code-yeongyu/lazycodex` repository/bin identity, not an npm package.
- **Components (10 live workspaces):** `comment-checker`, `git-bash`, `lazycodex-executor-verify`, `lsp`, `rules`, `ulw-execute-continuation`, `teammode`, `telemetry`, `ultrawork`, `ulw-loop` (per `plugin/package.json` `workspaces[]`), wired to Codex events `SessionStart`/`UserPromptSubmit`/`PreToolUse`/`PostToolUse`/`PostCompact`/`Stop`/`SubagentStop`. Plus `bootstrap` (runtime provisioner with its own package.json, deliberately outside the workspaces array), `test-support` (test helper dir, not a component), and `lcx` (skills-only carrier, no package.json, not a workspace). `workflow-selector` was removed 2026-06-29. No `team_*` tools (teammode is script+skill driven), no hashline; `.mcp.json` declares 4 servers: lsp + git-bash (local stdio) + grep_app + context7 (remote).
- **Ultrawork skill pointer (truncation-safe):** Codex App truncates large `UserPromptSubmit` hook output, so the ultrawork hook injects a compact `<ultrawork-mode>` skill pointer (<4096 bytes, pinned by `plugin/test/ultrawork-skill-pointer.test.mjs`) that instructs the model to `create_goal` then READ the full directive from the bundled `ultrawork` skill (`ultrawork/src/skill-pointer.ts`); falls back to the full inline directive when the plugin skills tree is absent. `ulw-loop/src/ultrawork-skill-pointer.ts` is a byte-identical mirror for the standalone `--with-ultrawork` path.
- **Install:** `bunx oh-my-openagent install --platform=codex` (or `bunx lazycodex-ai install`, or `--platform=both`) copies the plugin to `~/.codex/plugins/cache/sisyphuslabs/omo/<version>/`, writes a local marketplace snapshot under `~/.codex/.tmp/marketplaces/sisyphuslabs/plugins/omo/`, copies bundled agent TOMLs into `~/.codex/agents/`, enables `omo@sisyphuslabs` in `~/.codex/config.toml`, links the root `omo` runtime wrapper plus component CLIs into `~/.local/bin`. Windows: Git Bash preflight (`winget install --id Git.Git`). Installer source lives in [`packages/omo-codex/src/install/`](packages/omo-codex/src/install/); `packages/omo-codex/scripts/install*.mjs` are generated/bundled Node entrypoints that keep the published CLI paths stable.
- **Deploy / publish** ([`.github/workflows/publish.yml`](.github/workflows/publish.yml), manual dispatch):
  - `publish_lazycodex` (default **true**) publishes the npm alias `lazycodex-ai`: rewrites root `package.json` name to `lazycodex-ai` + version to the release + optionalDeps `oh-my-opencode-*` to `oh-my-openagent-*`, skips when `registry.npmjs.org/lazycodex-ai/${VERSION}` exists, publishes `--access public --provenance --tag latest`, then restores `package.json`. (The bare `lazycodex` npm name was unpublished 2026-05-30; `lazycodex-ai` is the live package.)
- Codex marketplace sync is **automatic for every stable release** (no manual toggle; the old `sync_lazycodex_marketplace` input was removed). The release-job steps are gated on `needs.release-metadata.outputs.dist_tag == ''` (stable only; dist-tagged versions such as the `beta` channel skip - this is the npm dist-tag, not GitHub's pre-release flag, which the pipeline never sets) and require secret `LAZYCODEX_SYNC_TOKEN` (enforced up-front by the `preflight-trust` token check, also gated on stable). They check out `code-yeongyu/lazycodex`, build the plugin + lsp-tools-mcp + lsp-daemon + git-bash-mcp, run [`script/sync-lazycodex-marketplace.ts`](script/sync-lazycodex-marketplace.ts) `<source-root> <lazycodex-root>`, then `git push origin HEAD:main`.
- **Sync mechanism is file copy + commit push, NOT a git subtree:** `marketplace.json` to `.agents/plugins/marketplace.json`; `plugin/` to `plugins/omo/`; bundles LSP/Git Bash MCP runtime dists to `plugins/omo/components/*/dist/`; bundles root CLI runtimes to `plugins/omo/dist/cli` and `plugins/omo/dist/cli-node`; rewrites `.mcp.json` paths; validates via `script/lazycodex-marketplace-validation.ts`. Root `package.json` `files` ships `dist/cli`, `dist/cli-node`, and `packages/omo-codex/{marketplace.json,plugin,plugin/.codex-plugin,scripts}`. First-publish playbook: [`docs/reference/lazycodex-npm-reservation.md`](docs/reference/lazycodex-npm-reservation.md). CI gate: `bun run test:codex` (ci.yml `codex-compatibility`; full suite ubuntu, platform smoke macos/windows).
- **Telemetry:** event `omo_codex_daily_active` (once per UTC day per machine, id `sha256("omo-codex:"+hostname)`); opt-out `OMO_CODEX_DISABLE_POSTHOG=1` / `OMO_CODEX_SEND_ANONYMOUS_TELEMETRY=0` (global flags also disable). Full internals: [`packages/omo-codex/AGENTS.md`](packages/omo-codex/AGENTS.md).

## MULTI-LEVEL CONFIG

One unified file configures every omo harness (OpenCode plugin, Senpi, Codex). Legacy `oh-my-openagent.json[c]` / `oh-my-opencode.json[c]` files and `~/.omo/config.jsonc` are read by nothing but the migration engine.

```text
Project layers:
  <pwd up to $HOME>/.omo/omo.json[c]
        ↓
User layer:
  ~/.omo/omo.json[c]
        ↓
Shared base
  → [harness]
  → profiles.<P>
  → profiles.<P>.[harness]
        ↓
Defaults
```

Project configuration wins over user configuration. The home directory itself is skipped as a project layer. Legacy configuration files are read only by the migration engine.

## IMPORTANT IMPLEMENTATION NOTES

## THREE-TIER MCP SYSTEM

| Tier | Source | Loader | Mechanism |
|------|--------|--------|-----------|
| 1. Built-in | `packages/omo-opencode/src/mcp/` | `createBuiltinMcps()` | 3 remote HTTP + 1 local stdio MCP (`lsp`) |
| 2. Claude Code | `.mcp.json` (project + user) | `claude-code-mcp-loader` | `${VAR}` env expansion (allowlist via `mcp_env_allowlist`) |
| 3. Skill-embedded | SKILL.md YAML frontmatter | `SkillMcpManager` (per-session) | stdio + HTTP, OAuth 2.0 + PKCE + DCR step-up |

## WHERE TO LOOK

> All plugin paths below are relative to [`packages/omo-opencode/`](packages/omo-opencode/src/AGENTS.md) (the OpenCode adapter). Core/MCP logic lives in sibling `packages/*`.

| Task | Location | Notes |
|------|----------|-------|
| Add new agent | `packages/omo-opencode/src/agents/` + `agents/builtin-agents/` | `createXXXAgent` factory + `mode: "primary" \| "subagent" \| "all"` |
| Add new hook | `packages/omo-opencode/src/hooks/{name}/` + register in `src/plugin/hooks/create-*-hooks.ts` | Pick the right tier (Session/ToolGuard/Transform/Continuation/Skill) |
| Add new tool | `packages/omo-opencode/src/tools/{name}/` + register in `src/plugin/tool-registry.ts` | Factory `createXXXTool` (most) or direct `ToolDefinition` (interactive_bash) |
| Add new feature module | `packages/omo-opencode/src/features/{name}/` | Standalone module wired into `plugin/` layer |
| Add new MCP (tier 1) | `packages/omo-opencode/src/mcp/` + register in `createBuiltinMcps()` | Remote HTTP or local stdio |
| Add new built-in skill | `packages/skills-loader-core/src/features/builtin-skills/skills/{name}.ts` + register in `skills.ts` | Implement `BuiltinSkill` interface |
| Add new command | `packages/omo-opencode/src/features/builtin-commands/` | Templates in `templates/` |
| Modify ultrawork prompts | `packages/prompts-core/prompts/ultrawork/*.md` | `packages/omo-opencode/src/hooks/keyword-detector/ultrawork/*.ts` are loader shims; keep `index.ts` and `source-detector.ts` routing stable |
| Add new CLI subcommand | `packages/omo-opencode/src/cli/cli-program.ts` | Commander.js subcommand |
| Add new doctor check | `packages/omo-opencode/src/cli/doctor/checks/` | Register in `checks/index.ts` |
| Modify config schema | `packages/omo-opencode/src/config/schema/` + add to `OhMyOpenCodeConfigSchema` | Zod v4; auto-included in `assets/oh-my-opencode.schema.json` after `bun run build:schema` |
| Add new category | `packages/omo-opencode/src/tools/delegate-task/constants.ts` | `DEFAULT_CATEGORIES` + `CATEGORY_MODEL_REQUIREMENTS` |
| Add new team-mode tool | `packages/omo-opencode/src/features/team-mode/tools/` + register in `src/plugin/tool-registry.ts` `teamModeToolsRecord` | Gated on `team_mode.enabled` |
| Reactive provider error recovery | `packages/omo-opencode/src/hooks/runtime-fallback/` | Distinct from `model-fallback` (proactive, chat.params) |
| External notifications | `packages/omo-opencode/src/openclaw/` | Bidirectional: outbound (event → HTTP/shell), inbound (Discord/Telegram daemon → tmux send-keys) |
| Skill-embedded MCP | `packages/omo-opencode/src/features/skill-mcp-manager/` | Tier-3 MCPs (per-session, stdio + HTTP) |
| Shared per-user LSP daemon (Codex) | `packages/lsp-daemon/` | Unix-socket / named-pipe daemon + stdio MCP proxy consuming `packages/lsp-core/` + `packages/mcp-stdio-core/` |
| Dependency-frontier DAG engine | `packages/senpi-task/src/dag/` | 35 files / ~14k LOC; WAL + fingerprint recovery; node admission keyed on dependsOn completion + free slot (waves informational only); the `dag` tool is registered by omo-senpi |
| Regenerate OpenGateway model catalog | `packages/omo-opencode/scripts/` | Writes tracked `src/features/opengateway-provider/opengateway-models.json`; distinct from `build:model-capabilities` |
| Senpi live QA drivers | `packages/omo-senpi/scripts/qa/` | Lanes: task/team/rpc/resume/memory/components/runtimes; sandbox + digest isolation, `--self-test` |

## CODE MAP

Digest-verified centrality (refs unmeasured unless noted):

| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| `createPluginModule()` | fn | `packages/omo-opencode/src/testing/create-plugin-module.ts` | - | Staged plugin init; build entry delegates here |
| `dispatchInternalPrompt()` | fn | `packages/utils/src/prompt-async-gate/` | - | ONLY sanctioned internal `session.prompt*` route |
| `canonicalAgentDir()` | fn | `packages/omo-native/bin/lib/agent-dir.js` | - | Single canonical `~/.omo/agent` resolution |
| `resolveAgentHome()` | fn | `packages/omo-senpi/src/components/agent-home/` | - | Adapter-side twin of `canonicalAgentDir()` |
| `buildTaskExecute` | fn | `packages/senpi-task/src/tools/task/` | ~103 | `task` tool factory; batch cap 16 on schema AND execution |
| `SCOPE_PRIORITY` | const | `packages/skills-loader-core/src/features/opencode-skill-loader/` | - | Numeric skill precedence across 7 discover* sources |
| `consumeSoulNoticeDelta()` | fn | `packages/memory-core/src/soul/` | - | Soul-notice watermark consumption |

## ARCHITECTURE INVARIANTS

- **Canonical agent order:** Sisyphus → Hephaestus → Prometheus → Atlas. Enforced by `installAgentSortShim()` (patches `Array.prototype.toSorted`/`.sort` narrowly when the array contains ≥2 canonical core agents). See [`packages/omo-opencode/src/plugin-handlers/AGENTS.md`](packages/omo-opencode/src/plugin-handlers/AGENTS.md) for the full history of why this exists.
- **Hashline edit + read pairing:** Every `Read` tool output is tagged with `LINE#ID` content hashes; `hashline_edit` validates the hash before applying. Stale hash → reject.
- **5-tier hook composition:** Session (24) + ToolGuard (18) + Transform (8) + Continuation (7) + Skill (2) = 59 composed hook slots; config-gated nulls by default: `team-tool-gating` (ToolGuard) + `team-mode-status-injector`/`team-mailbox-injector` (Transform) via `team_mode.enabled`, `monitor-status-injector` (Transform) via `monitor.enabled`, `goal` (Session) via `goal.enabled`, Session-tier `model-fallback` (`model_fallback`, default off) and `preemptive-compaction` (`experimental.preemptive_compaction`), and `interactive-bash-session` when tmux integration is off → **54 active on default config / 61 with team mode / 62 with monitor** (team mode also adds +4 direct event handlers in `packages/omo-opencode/src/plugin/event.ts`, `team-session-events/*`). Composed by `createCoreHooks()` + `createContinuationHooks()` + `createSkillHooks()`; the Transform tier also pulls `btwSideContextInjector` from `features/btw-side` and `contextInjectorMessagesTransform` from `features/context-injector` (neither is a `hooks/` dir).
- **Per-session MCP isolation:** Tier-3 MCP clients are keyed by `${sessionID}:${skillName}:${serverName}` so the same skill in two sessions does not share state.
- **Two fallback systems:** `model-fallback` (proactive, chat.params) vs `runtime-fallback` (reactive, session.error). They operate independently — no direct integration.
- **OpenClaw bidirectional:** Outbound dispatchers fire on session events; inbound daemon polls Discord/Telegram and `send-keys` replies into the tracked tmux pane.
- **Internal message injection is dangerous:** OpenCode's session message APIs can corrupt the main system when multiple hooks or tools inject messages concurrently.
  - Root cause to remember: OpenCode `promptAsync` returns before the prompt is durably accepted, and later failures can arrive as `session.error`. Multiple OMO hooks/tools can observe the same idle/error/completion edge and inject the same internal message into a live parent session.
- Treat every `session.prompt` / `session.promptAsync` call as a write to shared session state. Production code may call them only inside `packages/omo-opencode/src/shared/prompt-async-gate.ts`; all other routes must use `dispatchInternalPrompt({ mode: "async" | "sync", ... })` or a proven equivalent gate.
  - Required gate semantics: reserve per session before dispatch, check active session state, keep a short post-dispatch hold, release only on intentional abort/recovery paths, and restore optimistic task/loop state when dispatch is skipped or fails later.
  - Forbidden patterns: raw prompt calls outside the shared gate, `postDispatchHoldMs: 0`, no-session fallback to raw prompt, and new internal message routes without duplicate-injection regression tests.
  - Tests must pin both the shared invariant and the route behavior: update the static raw-prompt audit (kept under the architecture exception), then prove at the shared gate's owner boundary that concurrent/live/idle/error triggers collapse to one dispatch. A new route adds a row to that owner regression, not a new per-route test. The rows cover background completion wakes, fallback retries, team mailbox live delivery, recovery continuations, CLI run resumes, Claude Code hook injections, and sync/background subagent prompts.

## CONVENTIONS

- **Runtime:** Bun only (1.4.0, pinned identically in CI and `.devcontainer/Dockerfile`). Never npm/yarn/pnpm. (Exceptions: `packages/lsp-tools-mcp` + `packages/lsp-daemon` are Node-targeted, vendored, and built with `npm` + vitest/biome.)
- **TypeScript:** strict mode, ESNext, bundler moduleResolution, `bun-types` (never `@types/node`).
- **Tests:** Bun test (`bun:test`), co-located `*.test.ts`, given/when/then style — nested `describe` with `#given`/`#when`/`#then` prefixes, or inline `// given` / `// when` / `// then` comments. Never Arrange-Act-Assert comments.
- **CI tests:** every root-test leg runs the shared serial quarantine (`script/root-test-serial-quarantine.ts`) in one process, then parallelizes the remainder — Linux/macOS via `bunfig.root.parallel.toml`, Windows shard 2 via `bunfig.win2.parallel.windows.toml` after running `packages/senpi-task/src/runners/rpc-host` in its own invocation through `script/bun-panic-retry.ts` (one retry on a Bun crash only, oven-sh/bun#44390). `script/ci-fast-path.mjs` (`classifyCiMode`) runs the full OS matrix for every runtime-touching change (every path except an explicit allowlist of web, prose such as top-level Markdown and README/CHANGELOG/AGENTS-style Markdown outside `packages/*/src`, and listed repository metadata), platform-sensitive paths, or the `ci:full-matrix` label; every OS leg ends with `script/ci-leg-tests-guard.mjs`, which fails a leg that skipped tests the change needed (`tests not run: add ci:full-matrix`) and marks an intended skip as `tests intentionally not run`. `bun run test:fast` partitions locally (opencode-memory → senpi → root-rest via `bunfig.win2.toml`).
- **Test setup:** `test-setup.ts` preloaded via `bunfig.toml` resets session/cache state between tests.
- **Test authoring gate:** before adding or changing a test, answer the four questions in `.omo/rules/test-discipline.md` `## AUTHORING GATE`; extend the contract's owner test instead of adding a near-duplicate.
- **Factory pattern:** `createXXX()` for all tools, hooks, agents.
- **File naming:** kebab-case for files and directories.
- **Module structure:** `index.ts` barrel exports, **no catch-all files** (`utils.ts`, `helpers.ts`, `service.ts` banned), 200 LOC soft limit per file.
- **Imports:** relative within a module, barrel imports across modules (`import { log } from "./shared"`). **No path aliases inside package `src/`** — never `@/`. `packages/web/` is the only exception: it uses `@/*` (Next.js convention) and has its own tsconfig.
- **Config format:** JSONC with comments + trailing commas, Zod v4 validation, snake_case keys.
- **Dual package:** `oh-my-opencode` + `oh-my-openagent` published simultaneously during the rename transition.
- **Comments:** AI slop comment patterns blocked by `comment-checker` hook (binary: `@code-yeongyu/comment-checker`). Use `// @allow` to bypass single line, `// comment-checker-disable-file` at file top to bypass file. Sparingly.
- **Project skills/commands:** `.agents/` is authoritative during the `.opencode/` → `.agents/` migration - both load, consumers prefer `.agents/`; new skills land in `.agents/` only; drift between shared copies is a bug.

## UNIQUE STYLES

- `script/` contains Bun, TypeScript, build, publish, and QA automation.
- `scripts/` contains root Node ESM notice helpers.
- Emphatic all-caps directives in AGENTS.md and SKILL.md are binding contracts.
- Skill precedence is numeric: `opencode-project(6) > project(5) > opencode(4) > user(3) > config(2) > builtin=shared(1)`.

## ANTI-PATTERNS

- Never use `as any`, `@ts-ignore`, or `@ts-expect-error`.
- Never suppress lint or type errors.
- Never add emojis to code or comments unless requested.
- Never commit unless explicitly requested.
- Never run `bun publish` directly.
- Never modify package versions locally.
- Never write an existing file without reading it first.
- Never use `background_cancel(all=true)`.
- Never delete a failing test to make a build green.
- Never bypass a red required check.
- Never create catch-all files.
- Never use empty catch blocks.
- Never assert authored prompt or markdown prose in tests. Test machine-consumed fields, shipped-copy equality, parsing, routing, dispatch, state, security, and observable runtime behavior.

## CI/CD

| Workflow | Purpose |
|---|---|
| `ci.yml` | Root tests, typecheck, Codex compatibility, Senpi compatibility, build, payload checks, schema updates, and release drafting |
| `publish.yml` | Dual npm publish, `lazycodex-ai` alias publish, platform packages, GitHub release, and stable Codex marketplace sync |
| `publish-platform.yml` | Generated Node launcher packages |
| `sisyphus-agent.yml` | AI issue and PR handling |
| `refresh-model-capabilities.yml` | Weekly models.dev refresh |
| `cla.yml` | CLA checks |
| `lint-workflows.yml` | Workflow linting |
| `web-ci.yml` | Website checks |
| `web-deploy.yml` | Cloudflare deployment |
| `package-labels.yml` | Package labels |
| `stats.yml` | npm and release download statistics |

## DEVELOPMENT COMMANDS

```bash
bun test                          # Root Bun test suite in one process
bun run test:codex                # Codex Light gate: git-bash-mcp + lsp-tools-mcp + lsp-daemon + omo-codex plugin + third-party notices (ast-grep-mcp is senpi-side, not in this gate)
bun run build                     # Build plugin (ESM bundle ← packages/omo-opencode/src/index.ts + .d.ts + cli bundle + schema)
bun run build:all                 # Build + 12 generated platform launchers
bun run build:binaries            # 12 generated platform launchers only (script/build-binaries.ts)
bun run build:lsp-tools-mcp       # npm ci + build the vendored LSP MCP package
bun run build:lsp-daemon          # npm ci + build the vendored per-user LSP daemon package
bun run build:senpi-plugin       # Bundle the Senpi Pi plugin (chains build:ast-grep-mcp)
bun run build:codex-install      # Generate packages/omo-codex/scripts/install-dist (published Node entrypoints)
bun run build:schema              # Regenerate assets/oh-my-opencode.schema.json
bun run build:model-capabilities  # Refresh shared/model-capabilities cache from models.dev
bun run typecheck                 # tsgo --noEmit + typecheck:script + typecheck:packages (NOT tsc; @typescript/native-preview)
bun run typecheck:packages        # tsgo per workspace package
bun run test:senpi               # Senpi adapter unit gate (bun test packages/omo-senpi; live QA via senpi-qa skill)
bun run test:fast                # Partitioned local suite: opencode-memory → senpi → root-rest (bunfig.win2.toml)
bun run clean                     # rm -rf dist
bunx oh-my-opencode install       # Interactive setup wizard
bunx oh-my-opencode doctor        # Health diagnostics (4 categories: System / Config / Tools / Models)
bunx oh-my-opencode run <message> # Non-interactive session (auto-completes when todos done + no bg tasks)
bunx oh-my-opencode mcp oauth login <server-name> # Tier-3 MCP OAuth (PKCE + DCR); top-level command is `mcp` with nested `oauth login|logout|status`
```

## DEVELOPMENT ENVIRONMENT

The single source of truth is `script/agent/setup.sh`. It verifies Bun, Node, and Git, installs dependencies, and builds when `dist/index.js` is missing or `OMO_AGENT_FORCE_BUILD=1`.

| Harness | Committed wiring | Runs |
|---------|------------------|------|
| GitHub Codespaces / VS Code Dev Containers | [`.devcontainer/devcontainer.json`](.devcontainer/devcontainer.json) + [`.devcontainer/Dockerfile`](.devcontainer/Dockerfile) (Node 24 + Bun 1.4.0 + tmux, matching CI) | `postCreateCommand` runs `setup.sh` on container create |
| Plain Docker | [`script/agent/docker-dev.sh`](script/agent/docker-dev.sh) | builds the same Dockerfile, opens a shell |
| Cursor cloud agents | [`.cursor/environment.json`](.cursor/environment.json) | `install` runs `setup.sh` on environment creation |
| Claude Code | [`.claude/settings.json`](.claude/settings.json) | `SessionStart` runs `setup.sh`, `SessionEnd` launches `cleanup-hook.sh` |
| Codex App (local environments) | [`.codex/setup.sh`](.codex/setup.sh) | committable setup script Codex runs at project root on worktree creation |
| Codex Cloud / Codex CLI | no committable hook | Cloud: paste the `setup.sh` commands into the web-UI Setup script field. CLI: AGENTS.md only. |
| OpenCode (this plugin's own harness) | root [`AGENTS.md`](AGENTS.md) + [`CLAUDE.md`](CLAUDE.md) symlink | no worktree hook; run `script/agent/setup.sh` (Claude Code auto-runs it via `.claude/settings.json`) |

`script/agent/cleanup.sh` removes regenerable transients. Use `--deep` to remove `dist/`, vendored package distributions, and `node_modules/`.

`script/agent/cleanup-hook.sh` is the non-blocking Claude Code SessionEnd launcher.

All harnesses delegate to these scripts. Claude Code reads `CLAUDE.md`, which is a symlink to this file.

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | push/PR to master/dev | `block-master-pr` guard, root `bun test` (fast-path matrix via `script/ci-fast-path.mjs`; full OS matrix on runtime-touching or platform-sensitive paths or the `ci:full-matrix` label; a leg that skipped its tests never reports a plain pass), typecheck, codex-compatibility (full `bun run test:codex` plus per-component `npm run check` on ubuntu; platform smoke on macos/windows), senpi-compatibility (bundle `--check` + `bun test packages/omo-senpi`), lazycodex-published-smoke, build, omo-ai-payload-check (npm dry-run payload), auto-commit schema on master push, draft "next" release on dev push |
| `publish.yml` | manual dispatch | Test, typecheck, preflight-trust (OIDC verify workspace packages), dual npm publish (`oh-my-opencode` + `oh-my-openagent`) + `lazycodex-ai` npm alias (`publish_lazycodex`, default on) + automatic Codex marketplace sync to `code-yeongyu/lazycodex` on every **stable** release (no toggle; gated on empty `dist_tag`, needs `LAZYCODEX_SYNC_TOKEN`), 12 platform launcher packages, GitHub release, merge to master |
| `publish-platform.yml` | called by publish.yml | 12 generated Node launcher packages for darwin/linux/windows |
| `sisyphus-agent.yml` | @mention or manual dispatch | AI agent handles issues/PRs |
| `refresh-model-capabilities.yml` | weekly cron / dispatch | Refresh model capabilities from models.dev API |
| `cla.yml` | issue_comment / PR | CLA assistant for contributors |
| `lint-workflows.yml` | push/PR touching `.github/workflows/**` | actionlint only (`shellcheck=""` disables shellcheck) |
| `web-ci.yml` | push/PR to master/dev touching `packages/web/**`, `docs/**`, or the workflow file itself | format-check, lint, type-check, next build, opennextjs-cloudflare build |
| `web-deploy.yml` | push to master/dev touching `packages/web/**`, `docs/**`, or the workflow file itself, OR manual dispatch | Cloudflare Workers deploy via `cloudflare/wrangler-action@v3` (requires `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` secrets) |
| `package-labels.yml` | issues opened/edited + pull_request_target | Auto-applies package labels (`opencode` / `lazycodex` / `lazycodex-generated`) |
| `stats.yml` | weekly cron (Sun) / dispatch | Runs `script/stats.ts` (npm + GitHub-release download counts) |

For QA, source `script/agent/qa-sandbox.sh`. It provides isolated XDG directories, a temporary `CODEX_HOME`, and disables OpenCode auto-update and model fetching. QA must never read or write the host's real OpenCode or Codex state.

Whenever setup dependencies or configuration change, update this section, the matching sections in `CONTRIBUTING.md`, `.devcontainer/README.md` when relevant, and the matching QA skill. Keep setup scripts, documentation, and skills synchronized.

## NOTES

- **Logger:** writes `oh-my-opencode.log` to the OS temp dir (`/tmp` on Linux, `/var/folders/.../T/` on macOS, `%TEMP%` on Windows — i.e. Node's `os.tmpdir()`). Rotated at 50 MB; previous segments live at `.1` and `.2` (oldest dropped).
- **Background tasks:** 5 concurrent per `${providerID}/${modelID}` key by default (configurable via `background_task.modelConcurrency` / `providerConcurrency`); FIFO queue when slots full.
- **Plugin load timeout:** 10s for Claude Code plugin discovery.
- **Model fallback:** per-agent chains in `packages/omo-opencode/src/shared/model-requirements.ts`. **There is no single global priority.**
- **Two fallback systems:** `model-fallback` (proactive, chat.params, hardcoded chains) vs `runtime-fallback` (reactive, session.error, configurable per-category/agent).
- **Config migration:** idempotent via `_migrations` tracking, atomic writes with timestamped backups.
- **Goal feature (replaces ralph-loop):** `packages/omo-opencode/src/hooks/goal/` session-tier hook + `create_goal`/`update_goal`/`get_goal` tools, gated on `goal.enabled` (default off). Legacy `ralph_loop` config migrates to `goal` in `packages/omo-opencode/src/config/validate.ts` (deprecated schema shim); `ralph-loop` hook dir retained but no longer wired.
- **Build:** `bun build` (ESM, entry `packages/omo-opencode/src/index.ts`) + `tsc --emitDeclarationOnly`, external: `zod`.
- **CI tests:** root tests run through plain `bun test`; `packages/web/**` has its own package-level CI workflow.
- **Barrel `index.ts` files** establish module boundaries within `packages/omo-opencode/src/`.
- **Architecture rules** enforced via the `rules-injector` hook reading `.omo/rules/*.md` (e.g. `test-discipline.md`, `file-size-architectural-smell.md`, `typescript-programmer.md`).
- **Windows builds:** run on `windows-latest` (not cross-compiled) to avoid Bun segfaults.
- **Platform launchers:** detect AVX2 + libc family at runtime, fallback to baseline if needed.
- **IntentGate (`keyword-detector`):** classifies user intent (`ultrawork`/`ulw`, `search`, `analyze`, `team`) and injects mode-specific prompts.
- **Hashline edit:** every `Read` output tagged with `LINE#ID` content hashes (chars from `ZPMQVRWSNKTXJBYH`); edits reject on hash mismatch.
- **zauc-mocks pattern:** directories named `zauc-mocks-*` (under `packages/omo-opencode/src/hooks/`, `tools/`, `mcp/`, `shared/`) hold `mock.module()` setup that must load alphabetically before the tests that consume those mocked modules. The `zauc-` prefix is purely a sort-order hack for `bun:test` discovery; these are NOT hooks/tools.
- **Test discipline meta-audits:** repo-wide tests that parse source and FAIL the suite on invariant violations: `packages/omo-opencode/src/shared/mock-module-lifecycle-audit.test.ts` (`mock.module()` without restore) and `prompt-async-route-audit.test.ts` (raw `session.promptAsync` outside the gate) via the TS compiler API; `script/package-registration-audit.test.ts` (workspace/devDep registration + ROADMAP reverse-dependency edges stay zero); `script/shared-core-extraction-guard.test.ts` (`packages/*-core` stay harness-neutral); `packages/omo-opencode/src/shared/markdown-link-audit.test.ts` (no machine-local absolute paths in committed `.md`); `opencode-coupling-audit.test.ts` (×2 pkgs — non-adapter packages must not import `@opencode-ai/*`). Root-level cross-package invariants live in `tests/` (category drift, schema freshness, reasoning-vocabulary parity, ulw-loop/ulw-plan contracts).
- **Docs:** see [`docs/guide/`](docs/guide) for user-facing guides (overview, installation, orchestration, agent-model-matching, team-mode), [`docs/reference/`](docs/reference) for CLI/configuration/features reference. See also [`CHANGELOG.md`](CHANGELOG.md), [`docs/reference/prompt-async-gate-rfc.md`](docs/reference/prompt-async-gate-rfc.md), and [`docs/reference/release-process.md`](docs/reference/release-process.md).
- **Rules files** (auto-injected by `rules-injector` hook): scans `.omo/rules/`, `.claude/rules/`, `.cursor/rules/`, `.github/instructions/`, plus `.github/copilot-instructions.md` and `.mdc` files.
- **Process cleanup:** Background-agent error handlers are now log-only — no force-exit on transient errors. Opt out entirely via `OMO_DISABLE_PROCESS_CLEANUP=1` env var.
- **models.dev has two distinct consumers:** `bun run build:model-capabilities` (shared model-capabilities cache) and `packages/omo-opencode/scripts/` (OpenGateway catalog generator → tracked `opengateway-models.json`, shape-pinned by test). Do not conflate.
- **shared-skills sub-projects:** 17 skills; `ultimate-browsing/engine` and `coding-agent-sessions` are Python sub-projects with own tests; `visual-qa` ships a zero-dep bundled CLI (`scripts/visual-qa.mjs`) - regenerate the bundle after TS fixes.
- **First-prompt watchdog:** `packages/omo-opencode/src/hooks/runtime-fallback/first-prompt-watchdog.ts` detects subagent sessions producing no progress within 90s and triggers fallback / abort.
- **Runtime-fallback watchdog:** `packages/omo-opencode/src/hooks/runtime-fallback/first-prompt-watchdog.ts` detects no-progress subagent sessions, starts from the 90-second first-prompt window, and feeds progress-aware runtime fallback timers (`first_progress_timeout_seconds`, `stall_timeout_seconds`, `hard_timeout_seconds`) so long model thinking after progress is tolerated while true hangs still trigger fallback or abort.
- **ParentWakeNotifier:** Background-agent parent-wake state in `packages/omo-opencode/src/features/background-agent/parent-wake-notifier.ts` with dependency-injected client and enqueue callback.
- **Agent state directory:** ONE canonical location, `~/.omo/agent`, resolved through `canonicalAgentDir()` in [`packages/omo-native/bin/lib/agent-dir.js`](packages/omo-native/bin/lib/agent-dir.js) (and its adapter-side twin `resolveAgentHome()` in `packages/omo-senpi/src/components/agent-home/`). EVERY omo entry point — the spawned engine, `omo doctor`, `omo setup`, the local launcher, the local installer — MUST resolve the directory through that helper instead of composing its own default; an explicit `OMO_CODING_AGENT_DIR` (or the legacy `SENPI_CODING_AGENT_DIR` / `PI_CODING_AGENT_DIR`) still wins. Composing a private default is what made settings look erased on update.
- **Workspace migration:** Runtime state migrated from `.sisyphus/` → `.omo/`. Legacy `.sisyphus/` still exists during transition; `packages/omo-opencode/src/shared/legacy-workspace-migration.ts` copies it forward on first load.
- **CI nuance:** PRs targeting `master` are hard-blocked — they MUST target `dev`. CI auto-commits schema changes on master push and creates a draft "next" release on dev push.

## Review claim labels (merge-gating)

Three PR labels drive the review workflow; automation lives in `.github/workflows/review-claims.yml`:

- `will-review` — a reviewer claims the PR ("I will review this"). Applying it auto-requests the labeler as reviewer and BLOCKS merge via the required `Review claim gate` check.
- `in-review` — the claimer is actively reviewing. Same merge-blocking + auto-reviewer-request effects.
- `stale-review` — a claim sat 3+ days without the claimer's review; the sweep removes the claim labels and applies this one. A fresh claim clears it.

Rules:

- Apply `will-review` when you plan to review a PR; switch to `in-review` when you start.
- NEVER merge a PR carrying `will-review` or `in-review`; the gate check enforces this.
- Claim labels are removed automatically ONLY when the claimer (the person who applied the label) submits an approve or request-changes review. Do not remove someone else's claim label by hand.
- If a PR shows `stale-review`, it needs a (new) reviewer: claim it.

## PR MERGE POLICY

- PRs into `dev` must use merge commits.
- Use `gh pr merge <number> --merge --delete-branch` after CI, review work, and Cubic pass.
- Never squash-merge or rebase-merge.
- Never use `gh pr merge --admin` or bypass required checks.
- A red required check on `dev` remains a merge blocker.
- Never force-push shared branches.

## FINAL REMINDER

This repository is built for agents doing the work. Preserve evidence, follow the package boundaries, use the real harness for QA, and keep the authoritative instructions synchronized across every harness.
