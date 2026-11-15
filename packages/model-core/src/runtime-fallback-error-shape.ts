const DEFAULT_RETRY_ON_ERRORS = [429, 500, 502, 503, 504] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function getRecordValue(record: Record<string, unknown> | undefined, key: string): unknown {
  try {
    return record?.[key]
  } catch (cause) {
    // Unknown inputs may use hostile Proxy traps, so property-read failures cannot escape this boundary.
    if (!(cause instanceof Error)) {
      void cause
    }
    return undefined
  }
}

function getNestedRecord(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = getRecordValue(record, key)
  return isRecord(value) ? value : undefined
}

function readRuntimeFallbackErrorMessage(error: unknown, stringifyFallback: boolean): string {
  if (!error) return ""
  if (typeof error === "string") return error.toLowerCase()

  if (!isRecord(error)) {
    try {
      return JSON.stringify(error).toLowerCase()
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error
      }
      return ""
    }
  }

  const data = getNestedRecord(error, "data")
  const nestedError = getNestedRecord(error, "error")
  const dataError = getNestedRecord(data, "error")
  const records = [data, nestedError, error, dataError].filter(
    (value): value is Record<string, unknown> => value !== undefined,
  )

  for (const record of records) {
    const message = getRecordValue(record, "message")
    if (typeof message === "string" && message.length > 0) {
      return message.toLowerCase()
    }
  }

  const name = getRecordValue(error, "name")
  if (typeof name === "string" && name.length > 0) {
    const nameColonMatch = name.match(/:\s*(.+)/)
    if (nameColonMatch) return nameColonMatch[1]?.trim().toLowerCase() ?? ""
  }

  if (!stringifyFallback) return ""
  try {
    return JSON.stringify(error).toLowerCase()
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error
    }
    return ""
  }
}

export function getRuntimeFallbackErrorMessage(error: unknown): string {
  return readRuntimeFallbackErrorMessage(error, true)
}

function parseRuntimeFallbackPayload(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause
    return value
  }
}

function getResponsePayload(record: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const response = getNestedRecord(record, "response")
  const body = parseRuntimeFallbackPayload(getRecordValue(record, "responseBody") ?? getRecordValue(response, "body"))
  return isRecord(body) ? body : undefined
}

export function getRuntimeFallbackErrorEvidence(error: unknown): string {
  const root = isRecord(error) ? error : undefined
  const data = getNestedRecord(root, "data")
  const records = [root, data, getNestedRecord(root, "error"), getNestedRecord(data, "error"), getNestedRecord(root, "cause")]
  const fields: string[] = []
  const sources: Array<Record<string, unknown> | undefined> = [{ message: readRuntimeFallbackErrorMessage(error, false) }]
  for (const record of records) {
    const payload = getResponsePayload(record)
    sources.push(record, payload, getNestedRecord(payload, "error"))
  }
  for (const source of sources) {
    for (const key of ["message", "type", "code"]) {
      const value = getRecordValue(source, key)
      if (typeof value !== "string") continue
      if (key === "message") {
        const parsed = parseRuntimeFallbackPayload(value)
        if (isRecord(parsed)) sources.push(parsed, getNestedRecord(parsed, "error"))
        if (parsed !== value) continue
      }
      fields.push(value.toLowerCase())
    }
  }
  return fields.join(" ")
}

export function getRuntimeFallbackStatusCode(error: unknown, retryOnErrors?: readonly number[]): number | undefined {
  if (isRecord(error)) {
    const topLevelStatusCode = getRecordValue(error, "statusCode")
    if (typeof topLevelStatusCode === "number") return topLevelStatusCode

    const topLevelStatus = getRecordValue(error, "status")
    if (typeof topLevelStatus === "number") return topLevelStatus
  }

  const root = isRecord(error) ? error : undefined
  const data = getNestedRecord(root, "data")
  const nestedError = getNestedRecord(root, "error")
  const cause = getNestedRecord(root, "cause")

  for (const record of [data, nestedError, cause]) {
    const statusCode = getRecordValue(record, "statusCode")
    if (typeof statusCode === "number") return statusCode
  }

  const retryCodes = retryOnErrors ?? DEFAULT_RETRY_ON_ERRORS
  const pattern = new RegExp(`\\b(${retryCodes.join("|")})\\b`)
  const message = getRuntimeFallbackErrorMessage(error)
  const statusMatch = message.match(pattern)
  if (statusMatch?.[1]) {
    return Number.parseInt(statusMatch[1], 10)
  }

  return undefined
}

export function getRuntimeFallbackErrorName(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined

  const data = getNestedRecord(error, "data")
  const nestedError = getNestedRecord(error, "error")
  const dataError = getNestedRecord(data, "error")
  const records = [error, data, nestedError, dataError].filter(
    (value): value is Record<string, unknown> => value !== undefined,
  )

  for (const record of records) {
    const name = getRecordValue(record, "name")
    if (typeof name === "string" && name.length > 0) {
      return name
    }
  }

  return undefined
}

export function getRuntimeFallbackRetryableSignal(error: unknown): boolean | undefined {
  if (!isRecord(error)) return undefined

  const data = getNestedRecord(error, "data")
  const nestedError = getNestedRecord(error, "error")
  const dataError = getNestedRecord(data, "error")
  const cause = getNestedRecord(error, "cause")
  const records = [error, data, nestedError, dataError, cause].filter(
    (value): value is Record<string, unknown> => value !== undefined,
  )

  for (const record of records) {
    const retryable = getRecordValue(record, "isRetryable")
    if (typeof retryable === "boolean") return retryable
  }

  return undefined
}

export function getRuntimeFallbackRetryAfterMs(error: unknown): number | undefined {
  const root = isRecord(error) ? error : undefined
  const data = getNestedRecord(root, "data")
  const records = [
    root,
    data,
    getNestedRecord(root, "error"),
    getNestedRecord(data, "error"),
    getNestedRecord(root, "cause"),
  ]
  let duration: number | undefined
  for (const record of records) {
    const response = getNestedRecord(record, "response")
    const payload = getResponsePayload(record)
    for (const source of [record, response, payload, getNestedRecord(payload, "error")]) {
      const milliseconds = getRecordValue(source, "retryAfterMs")
      const seconds = getRecordValue(source, "retry_after")
      const headers = getNestedRecord(source, "responseHeaders") ?? getNestedRecord(source, "headers")
      const header = getRecordValue(headers, "retry-after") ?? getRecordValue(headers, "Retry-After")
      const headerMs =
        typeof header === "string"
          ? /^\s*\d+(?:\.\d+)?\s*$/.test(header)
            ? Number(header) * 1000
            : Date.parse(header) - Date.now()
          : undefined
      for (const value of [milliseconds, typeof seconds === "number" ? seconds * 1000 : undefined, headerMs]) {
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) duration = Math.max(duration ?? 0, value)
      }
    }
  }
  return duration
}
