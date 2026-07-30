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

### EVIDENCE: record it under `.omo/evidence/` or it DID NOT HAPPEN

**WRITE EVERY QA ARTIFACT TO `.omo/evidence/<YYYYMMDD>-<short-slug>/`**. Live Senpi QA is the scoped exception described above. Every change must record reviewer-readable plain files containing:

- **WHAT WAS TESTED:** the command or manual action, the surface driven, and the behavior it was meant to prove.
- **WHAT WAS OBSERVED:** before/after behavior, isolation proof, and the artifact path for captured output.
- **WHY IT IS ENOUGH:** how the evidence covers the intended behavior and remaining regression risk.
- **WHAT WAS OMITTED:** redact secrets, environment dumps, tokens, auth headers, and private credentials.

**NO EVIDENCE FILE == NO QA == NO COMMIT == NO PUSH.** ALWAYS. EVERY TIME. NO EXCEPTIONS.

## MANDATORY CHANGE-EXECUTION PROTOCOL

The moment a task requires producing a patch that modifies this repository, this protocol applies:

1. **EXPLORE.** Map the code before editing. Read the real files, trace call paths, and measure blast radius.
2. **MAKE A PLAN.** Write the complete plan to disk before the first edit.
3. **ADD TODOS IN ULTRA-DETAIL.** Mirror every atomic plan step into the todo list, including verification.
4. **MAKE A NEW WORKTREE.** All implementation happens in a fresh, task-owned git worktree.
5. **MAKE A PR AND WORK UNTIL IT GETS MERGED.** Fix CI, answer review, rerun QA, and resolve conflicts with `smart-rebase`.
6. **SET A GOAL AND RUN THE ULW LOOP.** Work must be evidence-bound, failing-first, and verified on the real surface.
7. **MANAGE THE TODO LIST OBSESSIVELY.** The todo list never lags reality.

## DEFAULT WORKFLOW

Unless the user explicitly says otherwise, or the task is an urgent hotfix, deliver every change through the `work-with-pr` skill. It uses an isolated worktree, evidence-bound manual QA, a reviewer-readable English PR, and the verification loop.

- A change under `packages/omo-opencode/` requires `opencode-qa`.
- A change under `packages/omo-codex/` requires `codex-qa`.
- A change under `packages/omo-senpi/` or `packages/senpi-task/` requires `senpi-qa`.
- A change touching more than one surface requires every matching QA skill.
- Resolve conflicts with `smart-rebase`, then rerun scoped QA.
- PRs into `dev` use merge commits. Never squash-merge or rebase-merge.

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
│   │       ├── mcp/                 # 5 built-in MCPs (3 remote + local stdio lsp + codegraph)
│   │       ├── plugin/ plugin-handlers/  # OpenCode hook handlers + 6-phase config loading pipeline
│   │       ├── openclaw/            # Bidirectional Discord/Telegram/HTTP/shell integration + reply listener daemon
│   │       └── generated/ help/ locales/ testing/ __tests__/  # model-capabilities, CLI help schemas, i18n, test factory, perf benchmarks
│   │   └── scripts/             # standalone codegen (OpenGateway + models.dev → tracked src/features/opengateway-provider/opengateway-models.json). See scripts/AGENTS.md
│   ├── omo-codex/                   # Codex CLI Light edition; vendored Codex plugin `omo` + TS installer + telemetry (`lazycodex` repo/bin identity, `lazycodex-ai` live npm alias)
│   ├── omo-senpi/                   # Senpi native TS extension adapter (local-path Pi package); 18 components incl. task + memory + init-deep-advisor (drives senpi-task + omo-config-core)
│   ├── omo-native/                  # npm `omo-ai` distribution (BETA channel): launcher spawning the pinned senpi engine + `canonicalAgentDir()` (~/.omo/agent)
│   ├── senpi-task/                  # Senpi-coupled task engine: state machine, store, in-process/RPC runners, lifecycle, completion, teams, dependency-frontier DAG engine (src/dag/, largest subsystem); 4 task + 6 lead-team tools (the `dag` tool is registered by omo-senpi)
│   ├── pi-goal/ pi-webfetch/        # Standalone Pi adapters: Codex-style goal tracking + bounded URL retrieval
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

Codex QA always uses an isolated `CODEX_HOME` and local mock model. Never test against the published package or the real user Codex directory.

## MULTI-LEVEL CONFIG

One unified configuration file configures every OMO harness.

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

- Canonical agent order is Sisyphus → Hephaestus → Prometheus → Atlas.
- Hashline pairs every `Read` result with a content hash. `hashline_edit` rejects stale hashes.
- Hooks are composed in five tiers: Session, ToolGuard, Transform, Continuation, and Skill.
- Tier-3 MCP clients are isolated by session, skill, and server name.
- `model-fallback` is proactive and runs in `chat.params`; `runtime-fallback` is reactive and runs on session errors.
- OpenClaw dispatches outbound session events and polls inbound Discord, Telegram, HTTP, and shell integrations.
- Every `session.prompt` and `session.promptAsync` call is a write to shared session state. Production code may call them only through `packages/omo-opencode/src/shared/prompt-async-gate.ts`.
- The prompt gate reserves a session before dispatch, checks active session state, keeps a short post-dispatch hold, and restores optimistic task or loop state when dispatch is skipped or fails.
- Tests must cover concurrent and duplicate internal prompt routes, including background completion wakes, fallback retries, Team Mode mailbox delivery, recovery continuations, CLI resumes, Claude Code hooks, and synchronous or background subagent prompts.

## CONVENTIONS

- **Runtime:** Bun only (1.4.0, pinned identically in CI and `.devcontainer/Dockerfile`). Never npm/yarn/pnpm. (Exceptions: `packages/lsp-tools-mcp` + `packages/lsp-daemon` are Node-targeted, vendored, and built with `npm` + vitest/biome.)
- **TypeScript:** strict mode, ESNext, bundler moduleResolution, `bun-types` (never `@types/node`).
- **Tests:** Bun test (`bun:test`), co-located `*.test.ts`, given/when/then style — nested `describe` with `#given`/`#when`/`#then` prefixes, or inline `// given` / `// when` / `// then` comments. Never Arrange-Act-Assert comments.
- **CI tests:** every root-test leg runs the shared serial quarantine (`script/root-test-serial-quarantine.ts`) in one process, then parallelizes the remainder — Linux/macOS via `bunfig.root.parallel.toml`, Windows shard 2 via `bunfig.win2.parallel.toml`. `script/ci-fast-path.mjs` (`classifyCiMode`) runs the full OS matrix only when platform-sensitive paths change or the `ci:full-matrix` label is set. `bun run test:fast` partitions locally (opencode-memory → senpi → root-rest via `bunfig.win2.toml`).
- **Test setup:** `test-setup.ts` preloaded via `bunfig.toml` resets session/cache state between tests.
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
bun install
bun run build
bun run build:all
bun run build:binaries
bun run build:lsp-tools-mcp
bun run build:lsp-daemon
bun run build:senpi-plugin
bun run build:codex-install
bun run build:schema
bun run build:model-capabilities
bun run typecheck
bun run typecheck:packages
bun run test:senpi
bun run test:fast
bun run clean
bunx oh-my-openagent install
bunx oh-my-openagent doctor
bunx oh-my-openagent run <message>
bunx oh-my-openagent mcp oauth login <server-name>
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

For QA, source `script/agent/qa-sandbox.sh`. It provides isolated XDG directories, a temporary `CODEX_HOME`, and disables OpenCode auto-update and model fetching. QA must never read or write the host's real OpenCode or Codex state.

Whenever setup dependencies or configuration change, update this section, the matching sections in `CONTRIBUTING.md`, `.devcontainer/README.md` when relevant, and the matching QA skill. Keep setup scripts, documentation, and skills synchronized.

## NOTES

- The logger writes `oh-my-opencode.log` to the OS temporary directory and rotates at 50 MB with `.1` and `.2` backups.
- Background tasks allow five concurrent tasks per provider/model key by default.
- Plugin load timeout is 10 seconds for Claude Code plugin discovery.
- Model fallback uses per-agent chains. There is no single global priority.
- Goal replaces the legacy ralph-loop configuration and is gated by `goal.enabled`.
- Builds use Bun ESM bundling with `zod` externalized.
- Windows builds run on `windows-latest` to avoid Bun cross-compilation issues.
- Platform launchers detect AVX2 and libc family at runtime.
- IntentGate classifies `ultrawork`, `search`, `analyze`, and `team` intent.
- Hashline IDs use characters from `ZPMQVRWSNKTXJBYH`.
- `zauc-mocks-*` directories contain alphabetically loaded mock-module setup and are not runtime hooks or tools.
- Test audits cover mock lifecycle restoration, raw prompt usage, package registration, Core package neutrality, markdown links, and OpenCode coupling.
- Documentation lives under `docs/guide/`, `docs/reference/`, and `CHANGELOG.md`.
- Rules injection scans `.omo/rules/`, `.claude/rules/`, `.cursor/rules/`, `.github/instructions/`, `.github/copilot-instructions.md`, and `.mdc` files.
- Background-agent error handlers are log-only for transient errors. Set `OMO_DISABLE_PROCESS_CLEANUP=1` to opt out of process cleanup.
- `models.dev` has two distinct consumers: `bun run build:model-capabilities` refreshes the shared model-capabilities cache, while `packages/omo-opencode/scripts/` generates the tracked OpenGateway catalog. Do not conflate them.
- Shared-skills contains 17 skills. `ultimate-browsing/engine` and `coding-agent-sessions` are Python subprojects with their own tests. `visual-qa` ships a bundled zero-dependency CLI; regenerate the bundle after TypeScript changes.
- **Runtime-fallback watchdog:** `packages/omo-opencode/src/hooks/runtime-fallback/first-prompt-watchdog.ts` detects no-progress subagent sessions, starts from the 90-second first-prompt window, and feeds progress-aware runtime fallback timers (`first_progress_timeout_seconds`, `stall_timeout_seconds`, `hard_timeout_seconds`) so long model thinking after progress is tolerated while true hangs still trigger fallback or abort.

## PR MERGE POLICY

- PRs into `dev` must use merge commits.
- Use `gh pr merge <number> --merge --delete-branch` after CI, review work, and Cubic pass.
- Never squash-merge or rebase-merge.
- Never use `gh pr merge --admin` or bypass required checks.
- A red required check on `dev` remains a merge blocker.
- Never hide failures with skipped tests, weakened assertions, retries, `continue-on-error`, or platform exclusions.

## FINAL REMINDER

This repository is built for agents doing the work. Preserve evidence, follow the package boundaries, use the real harness for QA, and keep the authoritative instructions synchronized across every harness.
