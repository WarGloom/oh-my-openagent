# Context Overflow Fallback QA

## What Was Tested

- Runtime fallback classification for `ContextOverflowError`, `context_length_exceeded`, and prompt/context-window overflow messages.
- Background-agent fallback classification for sanitized provider authorization failures.
- Provider-exhaustion fallback for Claude monthly spend-limit `SessionRetry` messages after provider auto-retry is exhausted.
- Runtime-fallback auto-retry signal detection for Claude reset-window status text.
- The local `opencode-qa` harness self-check and dependency/isolation setup.

## What Was Observed

- `targeted-tests.log`: `127 pass`, `0 fail`, across 6 focused fallback test files.
- `live-log-excerpts.txt`: real `/tmp/oh-my-opencode.log` entries show `ContextOverflowError` / `context_length_exceeded` followed by `[runtime-fallback] Error not retryable, skipping fallback` before the fix.
- `live-log-excerpts.txt`: real monthly spend-limit entries show `SessionRetry` ending with `Session error - no retry` before the fix.
- `opencode-qa-self-check.log`: OpenCode QA helper dependencies are present and its isolated XDG sandbox auto-removes on exit.
- `opencode-version.txt`: installed OpenCode reports `1.17.13-dev`.

## Why This Is Enough

The changed behavior is classifier and retry-policy logic, so focused unit coverage proves the exact failing signals now select fallback instead of stopping. The logs provide production evidence for the prior failure mode, and the OpenCode QA self-check verifies the harness required for live checks is available and isolated.

## What Was Omitted

No live provider-backed `opencode run` was spawned because the active reproduction condition includes real provider spend/quota exhaustion. Running it would consume quota and reproduce provider billing state rather than add deterministic proof beyond the captured real log plus targeted fallback-path tests.
