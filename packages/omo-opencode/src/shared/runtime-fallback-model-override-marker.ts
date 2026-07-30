const runtimeFallbackModelOverrideMessages = new WeakSet<object>()
const RUNTIME_FALLBACK_MODEL_OVERRIDE_KEY = "runtimeFallbackModelOverride"

type RuntimeFallbackModelOverrideMessage = {
  [RUNTIME_FALLBACK_MODEL_OVERRIDE_KEY]?: true
}

export function markRuntimeFallbackModelOverride(message: object): void {
  runtimeFallbackModelOverrideMessages.add(message)
  const markedMessage = message as RuntimeFallbackModelOverrideMessage
  markedMessage[RUNTIME_FALLBACK_MODEL_OVERRIDE_KEY] = true
}

export function hasRuntimeFallbackModelOverride(message: object): boolean {
  return runtimeFallbackModelOverrideMessages.has(message)
    || (message as RuntimeFallbackModelOverrideMessage)[RUNTIME_FALLBACK_MODEL_OVERRIDE_KEY] === true
}
