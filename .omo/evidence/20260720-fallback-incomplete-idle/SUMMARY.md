# QA Evidence — background-agent incomplete-latest-assistant idle fallback

**Date:** 2026-07-20
**Change scope:** `packages/omo-opencode/src/features/background-agent/session-idle-event-handler.ts` + `manager.ts` (2 source files) plus their co-located tests.
**Base branch:** `local/dev-stack` (see note at bottom — the entire reactive fallback machinery is unreleased and exists ONLY on `local/dev-stack`, not on `origin/dev`).

## WHAT WAS TESTED

1. **Deterministic behavior proof (unit, given/when/then):** both consumers of `classifySessionOutput` on the `"incomplete-latest-assistant"` branch.
   - Event path (`session-idle-event-handler.test.ts`): idle + incomplete + fallback succeeds -> `tryFallbackForNoOutputIdle` invoked with source `"session.idle incomplete-latest-assistant"`, task NOT failed, NOT completed; idle + incomplete + fallback returns false -> task stays `running`, `failNoOutputIdle` NOT called.
   - Poller path (`manager.polling.test.ts`): idle + incomplete + tool evidence + viable chain -> retries through fallback (promptAsync fires, model advances to fallback-model-1, attemptCount=1); idle + incomplete + tool evidence + no fallback -> task stays `running`, NOT `error` (the exact contrast with the sibling no-output case, which fails).
   - REGRESSION GUARD: a `busy` session carrying an incomplete `tool-calls` turn never reaches classification (`session.messages` never queried) and never triggers fallback — the long-running-tool (eBPF/26MB-curl) scenario is NOT treated as a failure.
   - Result: `45 pass / 0 fail` (see `unit-tests.log`).

2. **Full-suite regression baseline:** `bun test packages/omo-opencode/src/features/background-agent/`.
   - Base (my changes stashed): 785 pass, 9 fail, 2 errors.
   - With my changes: 788 pass, 9 fail, 2 errors.
   - Net: +3 passing tests, ZERO new failures. The 9 fail / 2 errors are pre-existing fake-timers infra failures in `task-completion-cleanup.test.ts` and siblings (reproduced identically on the untouched base), unrelated to this change.

3. **Typecheck:** `bun run typecheck` exit 0 (`typecheck.txt`).

4. **Real opencode integration (isolated XDG sandbox)** — `qa-driver.sh`:
   - Rebuilt `dist/index.js` (with the fix) loaded into real opencode 1.18.3-dev via an isolated config; a real server was started, the `/event` SSE stream captured, and a real session driven to idle.

## WHAT WAS OBSERVED

- **Isolation PROVEN:** host `~/.local/share/opencode/opencode.db` session count `3147` BEFORE and `3147` AFTER (`isolation.txt`). The driven session landed in the isolated sandbox DB (`isolated_db_sessions=1`), never the host.
- **Plugin loaded into real opencode:** `plugin.added` observed 45x on the wire (`event-stream.log`).
- **The changed code's trigger fires in real opencode:** `session.idle` observed 2x on the wire, alongside the full `busy -> idle -> session.idle` lifecycle. `busy`/`idle` are the exact session statuses the poller's `isActiveSessionStatus` gate (the regression-guard invariant) keys off. The rebuilt plugin processed these events without crashing.
- Event-type census (`event-stream.log`): `plugin.added` 45, `session.status` 4, `session.idle` 2, `busy` 2, `idle` 2, `session.created` 1, `session.error` 1, `server.connected` 1, etc.

## WHY IT IS ENOUGH

- The behavior change is a pure orchestration-decision change in the background-agent completion path. Its exact branch semantics (fallback-attempt-then-fall-through, never auto-fail, symmetric across event + poller, and the active-session short-circuit) are proven deterministically by the co-located unit tests, which drive the precise `classifySessionOutput` classifications and assert the fallback helper calls, task status, and non-failure.
- The real-opencode drive proves the rebuilt plugin integrates cleanly with the live harness: it loads, the `session.idle` trigger and `busy`/`idle` status transitions that reach the changed code actually fire on the wire, the completion path runs a real session end-to-end without regression, and the host DB is untouched.
- The regression the user feared (a long-running tool treated as an error) is locked by unit guard test (d) plus the observed `busy` status gating: fallback is reachable ONLY after a genuine terminal `session.idle`, never while the session is `busy`/`running`. `MIN_IDLE_TIME_MS`, `isActiveSessionStatus`, and `shouldWaitForFallbackRetryOutput` were not weakened, moved, or bypassed.

## WHAT WAS OMITTED / LIMITATIONS

- The end-to-end "a real background subagent stops mid-tool-call and then fallback fires on a live model" scenario is NOT deterministically reproducible in a bounded QA (it requires a real model to stop on an incomplete `tool-calls` turn). That exact branch is instead proven deterministically by the unit tests; the live drive proves integration + trigger firing + isolation + no-regression.
- The driven session ended with a `session.error` (the sandbox model credential path), which is orthogonal to this change — the `session.idle`/`busy`/`idle` lifecycle and plugin load still fired and were processed cleanly. No secrets, tokens, or auth headers are copied into this evidence; only sanitized event-type counts and DB session counts.

## BASE-BRANCH NOTE (reviewer-critical)

The task named base `dev`, but `origin/dev` contains NONE of the symbols this fix targets (`classifySessionOutput`, `"incomplete-latest-assistant"`, `tryNoOutputIdleFallback`, `NO_OUTPUT_IDLE_FALLBACK_ERROR_INFO`, `latestAssistantTurnIsIncomplete`, `sessionMessageHasToolEvidence`). That entire reactive-fallback rebuild lives only on `local/dev-stack` (commit `5bc5f1a04 fix(background-agent): rebuild task output lifecycle`), which is 48 commits / 468 files ahead of `origin/dev` and not yet delivered via a PR. The fix was therefore made on a branch off `local/dev-stack` (the only branch where the code exists) and targets `origin/local/dev-stack`.
