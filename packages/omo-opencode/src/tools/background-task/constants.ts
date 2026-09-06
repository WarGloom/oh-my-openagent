export const BACKGROUND_TASK_DESCRIPTION = `Run agent task in background. Returns a background task ID (\`bg_...\`) immediately; use it with \`background_output\` to retrieve that task's result after observing its terminal notification.

After observing a task's terminal notification, you may retrieve that task's result without waiting for unrelated tasks. Explicit skill/workflow requirements to wait for all responses before collection remain binding. Do not poll active tasks.
Wait for every required result before dependent stages or synthesis. A terminal notification is not proof of success: inspect failures and follow the workflow's failure policy instead of silently dropping required work.

Prompts MUST be in English.`

export const BACKGROUND_OUTPUT_DESCRIPTION = `Get output from background task. Use full_session=true to fetch session messages with filters. After observing a terminal notification, retrieve that task's result with block=false. - Timeout values are in milliseconds (ms), NOT seconds.

After observing a task's terminal notification, you may retrieve that task's result without waiting for unrelated tasks. Explicit skill/workflow requirements to wait for all responses before collection remain binding. Do not poll active tasks.
Wait for every required result before dependent stages or synthesis. A terminal notification is not proof of success: inspect failures and follow the workflow's failure policy instead of silently dropping required work.`

export const BACKGROUND_CANCEL_DESCRIPTION = `Cancel running background task(s). Use all=true to cancel ALL before final answer.`
