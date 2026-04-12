const TRUE_VALUES = new Set(["1", "true", "TRUE", "yes", "on"])

export function isRunDebugEnabled(): boolean {
  const envValue = process.env.OMO_RUN_DEBUG ?? process.env.OPENCODE_RUN_DEBUG
  return envValue !== undefined && TRUE_VALUES.has(envValue)
}

function formatRunMessage(message: string): string {
  return `[run-debug] ${new Date().toISOString()} ${message}`
}

export function logRunTrace(message: string): void {
  if (!isRunDebugEnabled()) return

  console.error(formatRunMessage(message))
}

export async function traceRunStep<T>(label: string, action: () => Promise<T>): Promise<T> {
  if (!isRunDebugEnabled()) {
    return await action()
  }

  const startTime = Date.now()
  logRunTrace(`${label} start`)
  try {
    const value = await action()
    const elapsedMs = Date.now() - startTime
    logRunTrace(`${label} done in ${elapsedMs}ms`)
    return value
  } catch (error) {
    const elapsedMs = Date.now() - startTime
    logRunTrace(`${label} failed after ${elapsedMs}ms: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

export function runDebugIteration(message: string, iteration: number): void {
  if (!isRunDebugEnabled() || iteration === 0) return
  if (iteration % 10 !== 1) return

  logRunTrace(message)
}
