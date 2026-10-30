---
name: git-master
description: "MUST USE for ANY git operations: atomic commits, rebase/squash/fixup, and history search (blame, bisect, log -S, reflog). Load it before running git yourself, or pass load_skills=['git-master'] to the task that commits. Triggers: 'commit', 'rebase', 'squash', 'who wrote', 'when was X added', 'find the commit that'."
---

# Git Master

Use this skill when the user asks you to operate on Git history or answer a Git-history question. Be exact, conservative, and evidence-led. Read the repository state before you infer anything.

## Mode Gate

Classify the request first. A request that also requires new commits uses `COMMIT`.

- `PUBLISH_EXISTING`: push or publish an already prepared and accepted commit. Follow Publish Existing and finish there, before Ground Truth or commit analysis.
- `COMMIT`: stage and commit local changes.
- `REBASE`: rebase, squash, fixup, autosquash, reorder, split, or otherwise rewrite branch history.
- `HISTORY`: answer when, where, who, why, or which commit changed something.
- `STATUS`: inspect branch, diff, or working-tree state without changing it.

Do not commit, rebase, push, force-push, reset, stash-pop, or delete anything unless the user explicitly asked for that operation. When a workflow the user started mandates one of them (ulw-loop commits each verified unit, ulw-execute lands its branches), that workflow's instruction is the ask. If the request is only investigative, report findings and stop.

## Publish Existing

1. Bind the authorized repository, destination branch, accepted commit and tree, and expected destination head for the lease. For an existing PR or stack, also bind its intended base name and live base OID and any required parent PR chain. Use current named remote refs and live PR metadata, not cached base hashes or history alone. Do not invent a PR or assume a default base.
2. Before pushing, recheck the destination ref. Permit confirmed absence only when branch creation is explicitly authorized and the lease expects absence. For an existing PR or stack, recheck the PR head and base name and OID, the required remote base branch, and each required parent. If a lookup fails or is unknown, a required base or parent is absent, deleted or merged, or any approved head or base changed, stop before push. An empty base ref or auto-retarget is not clean. Report the evidence and obtain the appropriate authorization; do not silently retarget, rebase or recreate a parent.
3. Push only with the user's authorization and exact expected lease, preserving normal hooks, the accepted tree, PR title and body, base, and others' changes. Retain still-valid required QA receipts. If a hook changes accepted inputs, stop; do not repair them in this mode. Do not create or stage commits, inspect message style or 30-commit history, reset, stash, rewrite, rebase, autosquash, or run a test campaign or full CI merely to publish unchanged accepted work.
4. After pushing, verify the exact destination ref. For an existing PR or stack, verify the PR head, named base and OID, and parent chain again. Report `commit_published`, `head_is_current`, `merge_into_named_base`, `parent_pr_blockers`, and `required_reviews_and_checks` separately with exact head and applicable base and verified pass, fail, pending, or unknown. Mark PR-only fields not applicable when there is no PR, not clean. Distinguish source conflicts, diff size, and review or check blockers. Publication does not establish PR readiness or stack readiness. Report only the requested outcome; do not automatically wait, poll, or request reviews. Merge, mark ready, auto-merge, self-approval, and protection changes require separate authority.

## Ground Truth

Gather independent facts in parallel when the tools allow it:

```bash
git status --short
git diff --stat
git diff --staged --stat
git branch --show-current
git log -30 --oneline
git log -30 --pretty=format:%s
git rev-parse --abbrev-ref @{upstream}
git merge-base HEAD origin/main
git merge-base HEAD origin/master
```

Missing upstream or missing `main`/`master` is normal. Fall back to the best available branch or report the missing fact. Never treat a failed lookup as proof.

## PR Body Evidence Attachments

When a PR body needs screenshots or terminal PNGs, the allowed hosting path is GitHub user attachments from the authenticated web attachment flow; never commit temporary images, never use GitHub Releases for PR evidence, and never use external image hosts. Do not log browser cookies, CSRF tokens, S3 form fields, or upload headers.

The flow needs an authenticated GitHub web session (a `gh` API token alone is not enough):

1. Open the target PR or issue page in that session and read its file-attachment CSRF token and repository id.
2. `POST https://github.com/upload/policies/assets` with `repository_id`, `name`, `size`, `content_type`, and that token as `authenticity_token`.
3. Upload the bytes to the returned S3 URL with the returned form fields exactly as given.
4. `PUT https://github.com/upload/assets/:id` with the returned `asset_upload_authenticity_token`.
5. Put only the final `https://github.com/user-attachments/assets/<uuid>` URL in the PR body (write the body to a temp file and pass it with `gh pr edit --body-file`).

If no authenticated browser session is available, leave the local evidence paths in the PR body and state the blocker.

## Commit Mode

Commit only the user's requested changes. Preserve unrelated dirty work.

1. Detect message style from recent history. Use the dominant local pattern, language, and casing. Do not default to Conventional Commits unless the repo uses them.
2. Inspect the full diff, not only filenames. Separate unrelated user edits from the requested commit.
3. Build atomic groups by behavior, module, and revertability. Keep implementation and its direct tests together.
4. Prefer multiple commits for unrelated concerns. A single commit is acceptable only when the changed files form one indivisible behavior or the user explicitly asks for one commit.
5. Stage by path or hunk so each commit contains only its atomic group.
6. Before each commit, verify `git diff --staged --stat` and enough staged diff to prove the group is right.
7. Commit with the detected style. After each commit, verify `git log -1 --oneline`.

Grouping rules:

- Split different features, modules, generated artifacts, config, docs, and test-only changes unless they are inseparable.
- Keep generated files with the source change that produced them when omitting them would leave the repo inconsistent.
- Never hide failing or unrelated changes inside a broad commit.

Final report: list commit hashes, messages, and any remaining uncommitted files.

## Rebase Mode

History rewriting is a shared-impact operation.

- Never rebase or rewrite `main`, `master`, `dev`, release branches, or a protected branch unless the user explicitly named that exact operation.
- If commits may already be pushed, ask before force-pushing. Use `--force-with-lease`, never plain `--force`.
- If the worktree is dirty, preserve it intentionally before rebasing. Do not stash-pop over conflicts without checking what changed.
- For fixups, prefer `git commit --fixup=<hash>` followed by `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash <base>`.
- For conflicts, read the conflicting files and resolve by intent. Do not choose ours/theirs blindly.
- If a rebase goes wrong, use `git rebase --abort` first. Use reflog only after explaining the recovery path.

After rewriting, run the relevant tests or at least the project's cheapest smoke check, then show the new branch log from base to HEAD.

## History Mode

Choose the Git tool by the question:

- `git log -S "text"`: when the count of an exact string changed.
- `git log -G "regex"`: when diffs touched lines matching a pattern.
- `git blame -L start,end -- file`: who last changed specific lines.
- `git log --follow -- file`: history across renames for one file.
- `git show <hash>`: inspect the commit that appears relevant.
- `git bisect`: find the first bad commit when there is a deterministic pass/fail command and known good/bad bounds.
- `git reflog`: recover or explain recent local history movement.

Always cite the exact command evidence in the answer: commit hash, subject, file path, and line or diff context when relevant. If the evidence is ambiguous, say what remains unproven.

## Safety Checks

Before any write to Git history:

- Current branch is known.
- Dirty work is accounted for.
- Upstream/pushed status is known or explicitly unknown.
- The operation matches the user's request.
- Recovery path is known (`rebase --abort`, reflog hash, or untouched worktree).

Before finishing:

- Run the most relevant verification available for the changed behavior or history operation.
- Report commands that passed and any command you could not run.
- Leave the worktree state explicit.
