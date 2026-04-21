---
name: update-omo
description: "Refresh and reconcile the full workspace for the current-folder OMO project (`oh-my-openagent`) together with its sibling repos: opencode, opencode-with-claude, and meridian. Refresh local base branches from upstream, sync the active feature branches, and MUST review new upstream changes in opencode-with-claude and meridian for their impact on our current fixes before verification. Use whenever the user asks to update OMO, refresh all related repos, sync branches across the workspace, bring everything up to date, re-check new plugin/proxy changes, compare new opencode-with-claude or meridian changes against our work, or wants branch sync plus impact analysis across the full workspace around the current-folder project." 
---

# Update OMO - Multi-Repo Sync + Impact Review

<role>
Orchestrator for refreshing the full working set around the current-folder OMO project (`oh-my-openagent`) across four sibling repositories, merging upstream base branches into active feature branches, and explicitly reviewing new plugin/proxy changes for their downstream impact on our current work.
</role>

## Repositories

| Repo | Path | Base branch | Upstream remote | Fork remote |
|------|------|-------------|-----------------|-------------|
| oh-my-openagent | `/home/nikita/work/Projects/ai/oh-my-openagent` | `dev` | `base` | `origin` |
| opencode | `/home/nikita/work/Projects/ai/opencode` | `dev` | `origin` | `fork` |
| opencode-with-claude | `/home/nikita/work/Projects/ai/opencode-with-claude` | `main` | `origin` | `fork` |
| meridian | `/home/nikita/work/Projects/ai/meridian` | `main` | `origin` | `fork` |

Reference codebase (read-only): `/home/nikita/work/Projects/ai/claude-code`

---

## Safety Rules (ABSOLUTE)

<safety>

1. **NEVER lose uncommitted work.** Before any refresh or merge, check `git status` and `git stash list`. If the working tree is dirty, stash first with a descriptive message.
2. **NEVER force push feature branches.** Only base-branch refreshes may use force-with-lease when the skill explicitly says to mirror the refreshed upstream baseline to the user's fork.
3. **NEVER commit unless the merge requires it** (merge commit) or the user explicitly asks.
4. **NEVER modify files outside the sync/review scope.** If you find pre-existing issues, report them but don't fix them unless they block the sync.
5. **Prefer merge over rebase** for active feature branches unless the user explicitly requests rebase.
6. **Restore stashes** after the sync/review completes if you created them.
7. **Do not skip the plugin/proxy review phase.** `opencode-with-claude` and `meridian` must be inspected for newly introduced behavior that could change, regress, or invalidate our local `oh-my-openagent` / `opencode` changes.

</safety>

---

## What makes `update-omo` different from `sync-dev`

This skill is not just a branch sync.

It must do all of the following:

1. Refresh base branches from upstream for **all four repos**.
2. Merge or sync those base branches into the currently active feature branches.
3. Review **new changes in `opencode-with-claude` and `meridian`** since the local feature branches diverged from their base branches.
4. Explain whether those new plugin/proxy changes affect our current work in:
   - `oh-my-openagent`
   - `opencode`
   - `opencode-with-claude`
   - `meridian`
5. Call out whether our local fixes should be adapted, revalidated, or dropped because upstream behavior changed.

If you only merge branches and skip that review, the skill is incomplete.

---

## Phase 0: Assessment

Before touching anything, gather state for **all four repos** in parallel.

<assessment>

### For each repo, run in parallel:

```bash
git remote update --prune

# Working tree state
git status --short

# Current branch
git branch --show-current

# Stash list
git stash list

# Ahead/behind base branch
git log --oneline HEAD..{BASE_BRANCH} | wc -l
git log --oneline {BASE_BRANCH}..HEAD | wc -l

# Existing merge in progress?
git merge HEAD 2>&1 | head -1
```

### Decision gate:

| Condition | Action |
|-----------|--------|
| Working tree dirty | `git stash push -m "update-omo: pre-sync stash $(date +%Y%m%d-%H%M%S)"` |
| Already on base branch | Refresh the base branch, but skip the feature-branch merge for that repo |
| Merge already in progress | Ask user whether to abort or continue |
| 0 commits from base | Mark repo as already up-to-date |
| Branch has unpushed commits | Proceed; sync stays local unless user explicitly asked to push |

### Report to user:

```text
## Update Assessment

### oh-my-openagent (branch: ...)
- Working tree: clean / N modified files (stashed)
- Behind dev by: N commits
- Ahead of dev by: N commits

### opencode (branch: ...)
- Working tree: clean / N modified files (stashed)
- Behind dev by: N commits
- Ahead of dev by: N commits

### opencode-with-claude (branch: ...)
- Working tree: clean / N modified files (stashed)
- Behind main by: N commits
- Ahead of main by: N commits

### meridian (branch: ...)
- Working tree: clean / N modified files (stashed)
- Behind main by: N commits
- Ahead of main by: N commits
```

</assessment>

---

## Phase 1: Refresh base branches from upstream

Refresh the local base branches from the original upstream repo first, then mirror the refreshed base branch to the user's fork.

<refresh>

### Base branch refresh pattern:

```bash
saved_branch=$(git branch --show-current)
git remote update --prune
git checkout {BASE_BRANCH}
git reset --hard {UPSTREAM_REMOTE}/{BASE_BRANCH}
git push {FORK_REMOTE} {BASE_BRANCH} --force-with-lease
git checkout "$saved_branch"
```

### Rules:

- `oh-my-openagent`: refresh `dev` from `base/dev`, push to `origin/dev`
- `opencode`: refresh `dev` from `origin/dev`, push to `fork/dev`
- `opencode-with-claude`: refresh `main` from `origin/main`, push to `fork/main`
- `meridian`: refresh `main` from `origin/main`, push to `fork/main`

- If the fork push is blocked by a **pre-existing base-branch verification failure**, report it clearly, keep the refreshed local base branch, and continue the sync using that local refreshed baseline.

</refresh>

---

## Phase 2: Review new plugin/proxy changes before merging

This phase is mandatory for:

- `opencode-with-claude`
- `meridian`

<review_phase>

### Goal

Identify new upstream changes since the local feature branches diverged from `main`, and determine whether those changes affect our current local work in the other repos.

### Required review questions

For **each** of `opencode-with-claude` and `meridian`, answer:

1. What changed on upstream base since our branch diverged?
2. Does any new change overlap with our local modifications?
3. Does any new change alter:
   - Anthropic request handling
   - beta header handling
   - advisor semantics
   - Claude Max / OAuth behavior
   - plugin initialization / request routing
   - streaming / response translation
   - error surface or fallback behavior
4. Does any upstream change invalidate, duplicate, or supersede our existing local fixes?
5. After merging the refreshed base branch, which repos must be revalidated because of those changes?

### Required commands

```bash
# Compare full divergence range
git log --oneline $(git merge-base HEAD {BASE_BRANCH})..{BASE_BRANCH}
git diff --stat $(git merge-base HEAD {BASE_BRANCH})..{BASE_BRANCH}
git diff $(git merge-base HEAD {BASE_BRANCH})..{BASE_BRANCH} -- <likely-relevant-paths>
```

### Review focus

Prefer these paths first when reviewing plugin/proxy repos:

#### opencode-with-claude
- `src/index.ts`
- `src/proxy.ts`
- `src/anthropic-proxy-config.ts`
- `package.json`
- tests touching plugin startup, Anthropic request forwarding, or Meridian integration

#### meridian
- `src/proxy/server.ts`
- `src/proxy/query.ts`
- `src/proxy/openai.ts`
- `src/proxy/betas.ts`
- `package.json`
- tests touching Anthropic beta handling, Claude SDK behavior, or response translation

### Required output

Produce a concise impact report:

```text
## Plugin / Proxy Impact Review

### opencode-with-claude
- New upstream changes: ...
- Overlap with our branch: yes/no
- Impact on our current fixes: ...
- Must revalidate after merge: yes/no

### meridian
- New upstream changes: ...
- Overlap with our branch: yes/no
- Impact on our current fixes: ...
- Must revalidate after merge: yes/no

### Net effect on current workspace
- oh-my-openagent: ...
- opencode: ...
- opencode-with-claude: ...
- meridian: ...
```

</review_phase>

---

## Phase 3: Merge refreshed base branches into active feature branches

Execute merges in parallel. One repo per subagent when possible.

<merge>

### Merge command:

```bash
git merge {BASE_BRANCH} --no-edit
```

### If merge succeeds (no conflicts)

Mark repo as merged and continue.

### If merge has conflicts

Resolve with these priorities:

1. **Generated files** (snapshots, lock files, generated schema): take base branch version, regenerate if necessary.
2. **Tests**: keep base-branch infrastructure changes, preserve local test additions.
3. **Source**: understand both sides' intent before choosing.

### Source conflict resolution rules

| Scenario | Resolution |
|----------|------------|
| Base branch refactored, feature branch modified old structure | Adapt feature logic to the new upstream structure |
| Both added different code in same region | Keep both, resolve imports/types |
| Upstream renamed/moved exports | Update feature branch imports to the new upstream names |
| Upstream removed code our branch depends on | Find the replacement path first; if none exists, report and ask |
| Plugin/proxy logic changed in upstream | Prefer upstream behavior, then re-apply only the local intent that still makes sense |

### After resolving conflicts:

```bash
grep -rn '<<<<<<< \|>>>>>>>' --include='*.ts' --include='*.tsx' --include='*.json' .
git add <resolved-files>
git commit --no-edit
```

</merge>

---

## Phase 4: Post-merge fixes

After merge commit, type errors, import issues, or stale assumptions may remain.

<post_merge>

### Common post-merge issues:

| Issue | Fix |
|-------|-----|
| Stale imports | Update imports to match upstream exports |
| Type mismatches | Adapt feature code to upstream types |
| Duplicate imports | Deduplicate, prefer upstream style |
| Plugin/proxy behavior drift | Reconcile local assumptions with upstream implementation |
| Fallback or Anthropic request regressions | Re-test current fixes against the merged upstream flow |

### Fix workflow:

```bash
bun run typecheck

# If merge introduced fixable type issues:
git add <fixed-files>
git commit -m "fix: resolve post-merge issues after update-omo sync"
```

</post_merge>

---

## Phase 5: Verification

Run verification for repos that changed, with extra emphasis on repos affected by plugin/proxy review findings.

<verification>

### Required verification by repo

#### oh-my-openagent
```bash
cd /home/nikita/work/Projects/ai/oh-my-openagent
bun run typecheck

# Targeted tests for merge-affected modules
git diff --name-only HEAD~1 | grep '\.test\.ts$' | xargs -I{} bun test {}
```

Do **not** run bare `bun test` here.

#### opencode
```bash
cd /home/nikita/work/Projects/ai/opencode
bun run typecheck
cd packages/opencode && bun test --timeout 30000
```

#### opencode-with-claude
```bash
cd /home/nikita/work/Projects/ai/opencode-with-claude
npm test
```

If specific plugin startup / Anthropic forwarding files changed, prioritize targeted tests that cover those paths.

#### meridian
```bash
cd /home/nikita/work/Projects/ai/meridian

# Prefer targeted tests for merge-affected files first
bun test <merge-affected-test-files>
```

If plugin/proxy review found upstream changes that affect our local behavior, run the targeted tests that cover those exact areas.

### Verification gates

| Gate | Required | Action on failure |
|------|----------|-------------------|
| Typecheck | MUST pass | Fix type issues introduced by the merge |
| Tests | MUST pass unless pre-existing | Fix merge-caused failures; report pre-existing failures clearly |
| Plugin/proxy impact review | MUST be completed | If skipped, sync is incomplete |

</verification>

---

## Phase 6: Cleanup and synthesis

<cleanup>

1. Restore stashes if any were created:
   ```bash
   git stash pop
   ```

2. Verify final working trees:
   ```bash
   git status --short
   ```

3. Report summary:

```text
## Update Complete

### oh-my-openagent
- Merged N commits from dev
- Conflicts resolved: N files
- Post-merge fixes: ...
- Verification: ...

### opencode
- Merged N commits from dev
- Conflicts resolved: N files
- Post-merge fixes: ...
- Verification: ...

### opencode-with-claude
- Merged N commits from main
- New upstream changes reviewed: yes/no
- Impact on our work: ...
- Verification: ...

### meridian
- Merged N commits from main
- New upstream changes reviewed: yes/no
- Impact on our work: ...
- Verification: ...

### Workspace impact synthesis
- Which local fixes remain valid
- Which fixes require adaptation
- Which repos need follow-up review or re-testing

Working trees: clean / dirty (list remaining intentional local changes)
```

</cleanup>

---

## Subagent Delegation

<delegation>

### Sync/merge subagents

Use `category="deep"` when conflict resolution or impact review is needed.

```ts
task(
  category="deep",
  load_skills=[],
  run_in_background=true,
  description="Update [repo] from [base branch]",
  prompt="..."
)
```

The prompt MUST include:
- full repo path
- current branch name
- base branch name
- upstream remote name and fork remote name
- refresh steps for the base branch
- merge command
- conflict rules
- verification commands
- whether plugin/proxy impact review is required for that repo

### Verification subagents

Use `category="quick"` for pure verification command runs.

```ts
task(
  category="quick",
  load_skills=[],
  run_in_background=true,
  description="Verify [repo] after update-omo sync",
  prompt="..."
)
```

### Parallelism

- Phase 0: assessment in parallel across all repos
- Phase 1: base-branch refresh in parallel across repos
- Phase 2: plugin/proxy review in parallel for `opencode-with-claude` and `meridian`
- Phase 3: merges in parallel where independent
- Phase 5: verification in parallel where independent

</delegation>

---

## Known Patterns

<patterns>

### oh-my-openagent
- Test infrastructure changes often land on `dev`; keep upstream test harness changes.
- Runtime fallback, Anthropic request shaping, and plugin-handler logic are hot conflict areas.

### opencode
- Provider/request plumbing and prompt/session flow refactors can invalidate local plugin assumptions.
- After merging `dev`, always re-check the exact path where provider defaults, headers, and providerOptions are resolved.

### opencode-with-claude
- Focus on plugin startup, provider interception, Meridian request forwarding, and Anthropic-specific passthrough logic.
- Any upstream change that touches plugin registration, proxy request shaping, or beta forwarding must be reviewed for impact on our `oh-my-openagent` and `opencode` assumptions.

### meridian
- Focus on `server.ts`, `query.ts`, `openai.ts`, and `betas.ts`.
- Any upstream changes to beta policy, Claude SDK request flow, response streaming, or error translation can directly change whether our local Anthropic fixes still make sense.

</patterns>
