export async function runWithAbortBudget<T>(input: {
  readonly timeoutMs: number
  readonly signal?: AbortSignal
  readonly run: (signal: AbortSignal) => Promise<T>
}): Promise<T> {
  input.signal?.throwIfAborted()
  const controller = new AbortController()
  const externalAbort = () => controller.abort(input.signal?.reason)
  const timer = setTimeout(
    () => controller.abort(new DOMException("Observer budget expired", "TimeoutError")),
    input.timeoutMs,
  )
  const interrupted = Promise.withResolvers<never>()
  const abort = () => interrupted.reject(controller.signal.reason)
  controller.signal.addEventListener("abort", abort, { once: true })
  input.signal?.addEventListener("abort", externalAbort, { once: true })
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        return input.run(controller.signal)
      }),
      interrupted.promise,
    ])
  } finally {
    clearTimeout(timer)
    controller.signal.removeEventListener("abort", abort)
    input.signal?.removeEventListener("abort", externalAbort)
  }
}
