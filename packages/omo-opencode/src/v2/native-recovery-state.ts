import type { FallbackState } from "../hooks/runtime-fallback/types"
import type { buildRetryModelPayload } from "../hooks/runtime-fallback/retry-model-payload"

type FailureReservation = {
  readonly id: string
  readonly result: Promise<boolean>
  pending: boolean
}

type NativeRecoveryState = {
  readonly states: Map<string, FallbackState>
  readonly inFlight: Set<string>
  readonly failures: Map<string, FailureReservation>
  readonly models: Map<string, NonNullable<ReturnType<typeof buildRetryModelPayload>>>
  readonly promptParams: Set<string>
}

const processState: typeof globalThis & { __omoNativeRecovery?: NativeRecoveryState } = globalThis
export const nativeRecoveryState: NativeRecoveryState = processState.__omoNativeRecovery ?? {
  states: new Map(),
  inFlight: new Set(),
  failures: new Map(),
  models: new Map(),
  promptParams: new Set(),
}
processState.__omoNativeRecovery = nativeRecoveryState

export function isNativeRecoveryPending(sessionID: string): boolean {
  return nativeRecoveryState.inFlight.has(sessionID) || nativeRecoveryState.failures.get(sessionID)?.pending === true
}

export function forgetNativeRecovery(sessionID: string): void {
  nativeRecoveryState.states.delete(sessionID)
  nativeRecoveryState.inFlight.delete(sessionID)
  nativeRecoveryState.failures.delete(sessionID)
  nativeRecoveryState.models.delete(sessionID)
}

export function recoverNativeFailure(sessionID: string, failureID: string, recover: () => Promise<boolean>): Promise<boolean> {
  const previous = nativeRecoveryState.failures.get(sessionID)
  if (previous?.id === failureID) return previous.result.then((handled) => handled || recoverNativeFailure(sessionID, failureID, recover))
  if (previous?.pending) return previous.result.then(() => recoverNativeFailure(sessionID, failureID, recover))

  const settled = Promise.withResolvers<boolean>()
  const reservation = { id: failureID, result: settled.promise, pending: true }
  nativeRecoveryState.failures.set(sessionID, reservation)
  void Promise.resolve().then(recover).then(
    (handled) => {
      reservation.pending = false
      if (!handled && nativeRecoveryState.failures.get(sessionID) === reservation) nativeRecoveryState.failures.delete(sessionID)
      settled.resolve(handled)
    },
    (error: unknown) => {
      if (nativeRecoveryState.failures.get(sessionID) === reservation) nativeRecoveryState.failures.delete(sessionID)
      settled.reject(error)
    },
  )
  return settled.promise
}
