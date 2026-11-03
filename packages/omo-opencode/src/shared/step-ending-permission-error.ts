/**
 * Marks the host's `Permission.DeclinedError`: a plain permission rejection (no feedback) that the
 * host contract (opencode-wt/v2 packages/plugin/src/promise/permission.ts) says must end the current
 * step. The V2 tool bridge rewraps that host error as this class so a tool catch that turns ordinary
 * permission denials into tool output can rethrow a step-ending rejection instead of swallowing it.
 * V1's `ToolContext.ask` never throws this class, so V1 handling is unchanged.
 */
export class StepEndingPermissionError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error && cause.message ? cause.message : "permission denied", { cause })
    this.name = "StepEndingPermissionError"
  }
}

/** True when the value is the host's `Permission.DeclinedError` (a plain reject with no feedback). */
export function isHostDeclinedError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { _tag?: unknown })._tag === "Permission.DeclinedError"
  )
}
