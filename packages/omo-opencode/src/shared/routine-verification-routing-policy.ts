export const ROUTINE_VERIFICATION_ROUTING_POLICY = `<Routine_Verification_Routing_Policy>
If the \`task\` tool itself (not \`task_*\`) is in your tool list, delegate routine verification-only runs (tests, typecheck, build, lint, smoke, log collection) to \`category="quick"\`. Quick runs and reports only, and never fixes. If \`task\` is absent, or the quick dispatch fails, run the verification your task requires yourself and report results. Never route fixes, UI, architecture or hard debugging to quick. Do not substitute \`call_omo_agent\`/explore for verification. Explicit instructions in your assignment take precedence.
</Routine_Verification_Routing_Policy>`

export const QUICK_VERIFICATION_BOUNDARY = `<Quick_Verification_No_Autonomous_Fixes>
When your assignment is verification-only, do not fix failures; report them.
</Quick_Verification_No_Autonomous_Fixes>`
