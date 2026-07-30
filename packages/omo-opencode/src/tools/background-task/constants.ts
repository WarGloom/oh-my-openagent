export const BACKGROUND_TASK_DESCRIPTION = `Run agent task in background. Returns a background task ID (\`bg_...\`) immediately; the system delivers an all-complete <system-reminder> notification when all sibling background tasks complete.

Do NOT poll for results. Use \`background_output\` only after the all-complete notification to get results.

Prompts MUST be in English.`

export const BACKGROUND_OUTPUT_DESCRIPTION = `Get output from background task. Use full_session=true to fetch session messages with filters. System notifies on completion, so block=true rarely needed. - Timeout values are in milliseconds (ms), NOT seconds.

IMPORTANT: ONLY call this tool after the all-complete <system-reminder> notification. Do NOT call after launch or after a partial notification that says other tasks are still in progress.`

export const BACKGROUND_CANCEL_DESCRIPTION = `Cancel running background task(s). Use all=true to cancel ALL before final answer.`
