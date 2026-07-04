# QA Evidence: runtime fallback declarations

## What was tested

- Focused classifier regression: `bun test packages/model-core/src/runtime-fallback-error-classifier.test.ts`
- Model-core declaration check: `bun x tsgo --noEmit -p packages/model-core/tsconfig.json`
- All workspace package declarations: `bun run typecheck:packages`
- Requested production build: `TMPDIR=.tmp/qa bun run build`
- OpenCode QA harness self-check: `TMPDIR=.tmp/qa bash .agents/skills/opencode-qa/scripts/lib/common.sh --self-check`
- Whitespace validation: `git diff --check`

## What was observed

- `merge.log` reported TS2367 because `context_overflow` was checked for retry after an earlier guard had already returned `false` for that type.
- `bun-test-runtime-fallback-classifier.txt`: all 8 classifier tests passed, including the native-compaction regression that requires context overflow to remain non-retryable.
- `model-core-tsgo.txt`: the model-core declaration check exited successfully with no diagnostics.
- `typecheck-packages.txt`: every workspace package declaration check passed.
- `bun-run-build-tail.txt`: the full production build reached `build:declarations` and completed all steps.
- `opencode-qa-common-self-check.txt`: the QA helper dependencies, loopback port check, and isolated XDG/HOME sandbox checks passed.
- `git-diff-check.txt`: no whitespace errors were reported.

## Why it is enough

The defect was an unreachable comparison introduced when provider-fallback changes were replayed after native context compaction became authoritative. The existing regression test directly protects the intended runtime behavior, the package checks protect the public TypeScript surface, and the full build exercises the exact declaration phase that failed in the update run.

## What was omitted

- No live provider context overflow was forced because the behavior is a deterministic, harness-neutral classifier decision already covered by the focused regression.
- No secrets, tokens, provider logs, or auth-bearing OpenCode logs were captured.
- The first QA self-check and build attempts were sandbox-blocked before meaningful execution; both were rerun in the host context with project-local temporary storage.
- No formatter was run because the repository exposes no formatter for `model-core`; the source change only deletes duplicate/unreachable union branches, and `git diff --check` passed.
