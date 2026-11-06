import parseDuration from "parse-duration"

type QuotaResponse = {
  readonly connectionKey?: string
  readonly model: { readonly providerID: string; readonly id: string }
  readonly request: Request
  readonly response: Response
}

const OPENAI_COUNTERS = ["requests", "tokens", "project-tokens"] as const
const DURATION = /^(?:\d+(?:\.\d+)?(?:ms|us|µs|ns|h|m|s))+$/
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i

export function createNativeQuotaSignals() {
  const resets = new Map<string, Map<string, number>>()
  return {
    observe(event: QuotaResponse): void {
      if (!event.connectionKey || !event.response.ok) return
      const headers = event.response.headers
      if ([...headers.keys()].some((name) => name.startsWith("x-codex-"))) return
      const url = new URL(event.request.url)
      const now = Date.now()
      let reset: number | undefined
      if (event.model.providerID === "openai" && url.origin === "https://api.openai.com") {
        for (const counter of OPENAI_COUNTERS) {
          const remaining = headers.get(`x-ratelimit-remaining-${counter}`)
          const raw = headers.get(`x-ratelimit-reset-${counter}`)
          if (remaining?.trim() !== "0" || !raw || !DURATION.test(raw)) continue
          const duration = parseDuration(raw)
          if (duration !== null && Number.isFinite(duration) && duration > 0) {
            const candidate = now + duration
            if (Number.isSafeInteger(candidate) && candidate > now) reset = Math.max(reset ?? 0, candidate)
          }
        }
      } else if (event.model.providerID === "anthropic" && url.origin === "https://api.anthropic.com") {
        const raw = headers.get("anthropic-ratelimit-requests-reset")
        if (headers.get("anthropic-ratelimit-requests-remaining")?.trim() === "0" && raw && RFC3339.test(raw)) {
          const candidate = Date.parse(raw)
          if (Number.isSafeInteger(candidate) && candidate > now) reset = candidate
        }
      }
      if (reset === undefined) return
      const model = `${event.model.providerID}/${event.model.id}`
      const connection = resets.get(event.connectionKey) ?? new Map<string, number>()
      connection.set(model, Math.max(connection.get(model) ?? 0, reset))
      resets.set(event.connectionKey, connection)
    },
    unavailable(connectionKey: string): ReadonlySet<string> {
      const now = Date.now()
      const connection = resets.get(connectionKey)
      if (!connection) return new Set()
      for (const [model, reset] of connection) if (reset <= now) connection.delete(model)
      if (connection.size === 0) resets.delete(connectionKey)
      return new Set(connection.keys())
    },
    clear(): void {
      resets.clear()
    },
  }
}
