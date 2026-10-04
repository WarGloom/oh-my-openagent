const fencedSessions = new Set<string>()
const admittedDispatches = new Map<string, Set<Promise<void>>>()
let admissionGuard: ((sessionID: string) => boolean) | undefined

export function configureInternalPromptAdmissionGuard(guard: (sessionID: string) => boolean): void {
  admissionGuard = guard
}

export function canAdmitInternalPrompt(sessionID: string): boolean {
  return !fencedSessions.has(sessionID) && admissionGuard?.(sessionID) !== false
}

export function trackAdmittedPrompt(sessionID: string, request: Promise<unknown>): void {
  let pending = admittedDispatches.get(sessionID)
  if (!pending) {
    pending = new Set()
    admittedDispatches.set(sessionID, pending)
  }
  const settled = request.then(
    () => undefined,
    () => undefined,
  )
  pending.add(settled)
  void settled.then(() => {
    pending.delete(settled)
    if (pending.size === 0) admittedDispatches.delete(sessionID)
  })
}

export async function fenceInternalPrompts(sessionID: string): Promise<void> {
  fencedSessions.add(sessionID)
  await Promise.all(admittedDispatches.get(sessionID) ?? [])
}

export function clearInternalPromptFencesForTesting(): void {
  fencedSessions.clear()
  admittedDispatches.clear()
}
