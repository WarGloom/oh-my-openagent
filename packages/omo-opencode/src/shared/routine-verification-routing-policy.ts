import { hasCategoryDispatchCapability } from "./agent-tool-restrictions"

export const ROUTINE_VERIFICATION_ROUTING_POLICY = `<Routine_Verification_Routing_Policy>
## Routine Verification Routing
- Delegate routine verification-only execution/reporting to \`category="quick"\`: targeted test, typecheck, build, lint, smoke-check, and log-collection commands.
- \`quick\` may run and summarize verification; it must not make autonomous fixes.
- If quick verification fails, report concise failures and escalate the fix to the proper category.
- Never route UI/design, architecture, hard debugging, or non-trivial implementation/fixes to \`quick\`; use \`visual-engineering\`, \`ultrabrain\`, \`deep\`, \`unspecified-high\`, or the specific domain category instead.
</Routine_Verification_Routing_Policy>`

export const QUICK_VERIFICATION_BOUNDARY = `<Quick_Verification_No_Autonomous_Fixes>
You may run and summarize verification, but must not make autonomous fixes. Report failures to the parent for routing to the appropriate implementation worker.
</Quick_Verification_No_Autonomous_Fixes>`

const CAPABILITY_ANNOTATION = /<Routine_Verification_Capability task="(true|false)" available="(true|false)" \/>/g

export function annotateRoutineVerificationCapability(
  prompt: string,
  tools: Readonly<Record<string, unknown>>,
  taskAvailable = true,
): string {
  const source = prompt.replace(CAPABILITY_ANNOTATION, "")
  if (!source.includes("<Routine_Verification_Routing_Policy>")) return source
  const task = hasCategoryDispatchCapability(tools)
  return task && taskAvailable
    ? source
    : `${source}\n<Routine_Verification_Capability task="${task}" available="${taskAvailable}" />`
}

export function resolveRoutineVerificationTools(
  system: readonly string[],
  sessionTools: Readonly<Record<string, boolean>> = {},
): Readonly<Record<string, boolean>> {
  const annotation = Array.from(system.join("\n").matchAll(CAPABILITY_ANNOTATION))[0]
  const task = sessionTools.task ?? sessionTools["*"] ?? (annotation?.[1] !== "false")
  return {
    ...sessionTools,
    task: annotation?.[2] !== "false" && hasCategoryDispatchCapability({ task }),
  }
}

export function scopeRoutineVerificationRoutingPolicy(
  prompt: string,
  tools: Readonly<Record<string, unknown>> = {},
): string {
  const source = prompt.replace(CAPABILITY_ANNOTATION, "")
  return hasCategoryDispatchCapability(tools)
    ? source
    : source.replace(/<Routine_Verification_Routing_Policy>[\s\S]*?<\/Routine_Verification_Routing_Policy>/g, "")
}
