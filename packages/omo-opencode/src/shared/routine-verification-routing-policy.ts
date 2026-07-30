export const ROUTINE_VERIFICATION_ROUTING_POLICY = `<Routine_Verification_Routing_Policy>
## Routine Verification Routing
- Delegate routine verification-only execution/reporting to \`category="quick"\`: targeted test, typecheck, build, lint, smoke-check, and log-collection commands.
- \`quick\` may run and summarize verification; it must not make autonomous fixes.
- If quick verification fails, report concise failures and escalate the fix to the proper category.
- Never route UI/design, architecture, hard debugging, or non-trivial implementation/fixes to \`quick\`; use \`visual-engineering\`, \`ultrabrain\`, \`deep\`, \`unspecified-high\`, or the specific domain category instead.
</Routine_Verification_Routing_Policy>`
