const MAX_PARENT_VISIBLE_ERROR_LENGTH = 2_000
export const MAX_PARENT_VISIBLE_NOTIFICATION_LENGTH = 12_000
const REDACTED = "[REDACTED]"
const GENERIC_PARENT_VISIBLE_ERROR = "Task failed. Raw error details are available in internal logs."

const SENSITIVE_FIELD_NAMES = [
  "Authorization",
  "Proxy-Authorization",
  "x-api-key",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "api_key",
  "apiKey",
  "access_token",
  "refresh_token",
  "id_token",
  "session_token",
  "token",
  "password",
  "passwd",
  "pwd",
  "secret",
  "client_secret",
  "private_key",
  "credentials",
  "Cookie",
  "Set-Cookie",
  "session",
].join("|")

const QUOTED_DOUBLE_SECRET_FIELD_PATTERN = new RegExp(
  `("(?:${SENSITIVE_FIELD_NAMES})"\\s*:\\s*")((?:\\\\.|[^"\\\\])*)(")`,
  "gi",
)
const QUOTED_SINGLE_SECRET_FIELD_PATTERN = new RegExp(
  `('(?:${SENSITIVE_FIELD_NAMES})'\\s*:\\s*')((?:\\\\.|[^'\\\\])*)(')`,
  "gi",
)
const AUTHORIZATION_HEADER_PREFIX_PATTERN = /\b(?:Authorization|Proxy-Authorization)\b\s*:\s*/gi

const SECRET_PATTERNS: RegExp[] = [
  /(["']?\b(?:Authorization|Proxy-Authorization)\b["']?\s*:\s*["']?(?:Bearer|Basic)\s+)[^"'\s,;}]+/gi,
  /(["']?\b(?:x-api-key)\b["']?\s*[:=]\s*["']?)[^"'\s,;&}]+/gi,
  /(["']?\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|api_key|apiKey|access_token|refresh_token|id_token|session_token|token|password|passwd|pwd|secret|client_secret|private_key|credentials)\b["']?\s*[:=]\s*["']?)[^"'\s,;&}]+/gi,
  /(["']?\b(?:Cookie|Set-Cookie|session)\b["']?\s*:\s*["']?)[^"'\n\r}]+/gi,
  /\bsk-proj-[A-Za-z0-9_-]+/g,
  /\bsk-ant-[A-Za-z0-9_-]+/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9_]+/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bxox[a-zA-Z]-[A-Za-z0-9-]+/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /([?&](?:api_key|apiKey|access_token|refresh_token|id_token|session_token|session|token|password|passwd|pwd|secret|client_secret|private_key|credentials)=)[^&#\s]+/gi,
  /-----BEGIN [^-]*(?:PRIVATE KEY|SECRET|CREDENTIALS)[\s\S]*?-----END [^-]*(?:PRIVATE KEY|SECRET|CREDENTIALS)-----/gi,
]

const PROMPT_MARKUP_PATTERNS: Array<[RegExp, string]> = [
  [/<system-reminder>/gi, "&lt;system-reminder&gt;"],
  [/<\/system-reminder>/gi, "&lt;/system-reminder&gt;"],
  [/<tool_call>/gi, "&lt;tool_call&gt;"],
  [/<\/tool_call>/gi, "&lt;/tool_call&gt;"],
]

function redactSecretMatch(match: string, prefix?: string): string {
  if (typeof prefix === "string" && prefix.length > 0 && match.startsWith(prefix)) {
    return `${prefix}${REDACTED}`
  }

  return REDACTED
}

function isEscaped(text: string, index: number): boolean {
  let backslashCount = 0
  for (let current = index - 1; current >= 0 && text[current] === "\\"; current -= 1) {
    backslashCount += 1
  }

  return backslashCount % 2 === 1
}

function hasPromptMarkupBoundary(text: string, index: number): boolean {
  return /^\s+<\/?(?:system-reminder|tool_call)>/i.test(text.slice(index))
}

function hasNextHeaderBoundary(text: string, index: number): boolean {
  return /^\s+[A-Za-z][A-Za-z0-9-]*\s*:/.test(text.slice(index))
}

function findPromptMarkupBoundaryOrTextEnd(text: string, start: number): number {
  for (let index = start; index < text.length; index += 1) {
    if (hasPromptMarkupBoundary(text, index)) {
      return index
    }
  }

  return text.length
}

function findPreviousNonWhitespaceIndex(text: string, index: number): number | undefined {
  for (let current = index - 1; current >= 0; current -= 1) {
    if (!/\s/.test(text[current])) {
      return current
    }
  }

  return undefined
}

function findUnescapedQuoteEnd(text: string, quoteStart: number, quote: string): number | undefined {
  for (let index = quoteStart + 1; index < text.length; index += 1) {
    if (text[index] === quote && !isEscaped(text, index)) {
      return index
    }
  }

  return undefined
}

function findEscapedQuoteEnd(text: string, quoteStart: number, quote: string): number | undefined {
  for (let index = quoteStart + 1; index < text.length; index += 1) {
    if (text[index] === quote && isEscaped(text, index)) {
      return index
    }
  }

  return undefined
}

function isAuthParamQuotedValueStart(text: string, index: number): boolean {
  const previousIndex = findPreviousNonWhitespaceIndex(text, index)

  return previousIndex !== undefined && text[previousIndex] === "="
}

function isSchemeQuotedTokenStart(text: string, valueStart: number, index: number): boolean {
  return /\b(?:Bearer|Basic)\s*$/i.test(text.slice(valueStart, index))
}

function findRawAuthorizationHeaderValueEnd(text: string, valueStart: number): number {
  let quote: string | undefined
  let quoteIsEscaped = false
  const valueWrapperQuote = text[valueStart]
  const nextValueCharacter = text[valueStart + 1]
  const escapedValueWrapperQuote =
    text[valueStart] === "\\" && (nextValueCharacter === '"' || nextValueCharacter === "'")
      ? nextValueCharacter
      : undefined

  if (escapedValueWrapperQuote !== undefined) {
    const quoteEnd = findEscapedQuoteEnd(text, valueStart + 1, escapedValueWrapperQuote)

    if (quoteEnd !== undefined) {
      return quoteEnd + 1
    }

    return findPromptMarkupBoundaryOrTextEnd(text, valueStart + 2)
  }

  if ((valueWrapperQuote === '"' || valueWrapperQuote === "'") && !isEscaped(text, valueStart)) {
    const quoteEnd = findUnescapedQuoteEnd(text, valueStart, valueWrapperQuote)

    if (quoteEnd !== undefined) {
      return quoteEnd + 1
    }

    return findPromptMarkupBoundaryOrTextEnd(text, valueStart + 1)
  }

  for (let index = valueStart; index < text.length; index += 1) {
    const character = text[index]

    if (quote !== undefined) {
      const isClosingQuote = quoteIsEscaped ? isEscaped(text, index) : !isEscaped(text, index)
      if (character === quote && isClosingQuote) {
        quote = undefined
        quoteIsEscaped = false
      }
      continue
    }

    if ((character === '"' || character === "'") && isEscaped(text, index)) {
      const quoteMarkerStart = index - 1
      if (
        isAuthParamQuotedValueStart(text, quoteMarkerStart) ||
        isSchemeQuotedTokenStart(text, valueStart, quoteMarkerStart)
      ) {
        const quoteEnd = findEscapedQuoteEnd(text, index, character)

        if (quoteEnd === undefined) {
          return text.length
        }

        quote = character
        quoteIsEscaped = true
      }
      continue
    }

    if (
      (character === '"' || character === "'") &&
      !isEscaped(text, index) &&
      (isAuthParamQuotedValueStart(text, index) || isSchemeQuotedTokenStart(text, valueStart, index))
    ) {
      const quoteEnd = findUnescapedQuoteEnd(text, index, character)

      if (quoteEnd === undefined) {
        return text.length
      }

      quote = character
      quoteIsEscaped = false
      continue
    }

    if (character === '"' || character === "'" || character === "}" || character === "]") {
      return index
    }

    if (hasPromptMarkupBoundary(text, index) || hasNextHeaderBoundary(text, index)) {
      return index
    }
  }

  return text.length
}

function redactRawAuthorizationHeaders(text: string): string {
  let redacted = ""
  let cursor = 0

  for (const match of text.matchAll(AUTHORIZATION_HEADER_PREFIX_PATTERN)) {
    const prefix = match[0]
    const matchStart = match.index
    const valueStart = matchStart + prefix.length

    if (matchStart < cursor) {
      continue
    }

    const valueEnd = findRawAuthorizationHeaderValueEnd(text, valueStart)
    redacted += `${text.slice(cursor, valueStart)}${REDACTED}`
    cursor = valueEnd
  }

  return `${redacted}${text.slice(cursor)}`
}

export function sanitizeParentVisibleError(error: string): string {
  let sanitized = error.replace(/[\x00-\x1F\x7F]/g, " ")

  sanitized = sanitized.replace(/https?:\/\/([^\s:/?#]+):([^\s@/?#]+)@/gi, (match) => {
    return match.replace(/:\/\/[^:]+:[^@]+@/, `://${REDACTED}:${REDACTED}@`)
  })

  sanitized = sanitized.replace(QUOTED_DOUBLE_SECRET_FIELD_PATTERN, (_match, prefix: string, _value: string, suffix: string) => {
    return `${prefix}${REDACTED}${suffix}`
  })
  sanitized = sanitized.replace(QUOTED_SINGLE_SECRET_FIELD_PATTERN, (_match, prefix: string, _value: string, suffix: string) => {
    return `${prefix}${REDACTED}${suffix}`
  })
  sanitized = redactRawAuthorizationHeaders(sanitized)

  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, redactSecretMatch)
  }

  for (const [pattern, replacement] of PROMPT_MARKUP_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement)
  }

  if (sanitized.length <= MAX_PARENT_VISIBLE_ERROR_LENGTH) {
    return sanitized
  }

  return `${sanitized.slice(0, MAX_PARENT_VISIBLE_ERROR_LENGTH)}… [truncated]`
}

export function formatParentVisibleError(error: string | undefined): string {
  if (!error || error.trim().length === 0) {
    return GENERIC_PARENT_VISIBLE_ERROR
  }

  const normalized = error.toLowerCase()

  if (/\b(?:401|403)\b/.test(normalized) || /\b(?:auth|authorization|unauthori[sz]ed|forbidden|credential|api[_ -]?key|token)\b/.test(normalized)) {
    return "Authentication or provider authorization failed."
  }

  if (/\b(?:429|rate\s*limit|quota|too many requests|resource exhausted)\b/.test(normalized)) {
    return "Provider rate limit or quota error."
  }

  if (/\b(?:model not found|unknown provider|provider not found|unsupported model|model unavailable)\b/.test(normalized)) {
    return "Provider or model unavailable."
  }

  if (/\b(?:timeout|timed out|deadline|aborted|cancelled|canceled|interrupted)\b/.test(normalized)) {
    return "Task timed out, was cancelled, or was interrupted."
  }

  if (/\b(?:network|connection|econnreset|enotfound|socket|tls|dns)\b/.test(normalized)) {
    return "Provider or network transport error."
  }

  return GENERIC_PARENT_VISIBLE_ERROR
}

export function limitParentVisibleNotification(notification: string): string {
  if (notification.length <= MAX_PARENT_VISIBLE_NOTIFICATION_LENGTH) {
    return notification
  }

  const suffix = "\n… [notification truncated]"
  return `${notification.slice(0, MAX_PARENT_VISIBLE_NOTIFICATION_LENGTH - suffix.length)}${suffix}`
}
