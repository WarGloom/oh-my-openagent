import { describe, expect, test } from "bun:test"
import {
  MAX_PARENT_VISIBLE_NOTIFICATION_LENGTH,
  limitParentVisibleNotification,
  sanitizeParentVisibleError,
} from "./parent-visible-error-sanitizer"

describe("sanitizeParentVisibleError", () => {
  test("#given sensitive fields and auth headers #when sanitizing #then every value is redacted", () => {
    // given
    const input = [
      '{"token":"slack-token-redacted-for-test"}',
      '{"secret":"github-token-redacted-for-test"}',
      '{"private_key":"anthropic-key-redacted-for-test"}',
      '{"api_key":"google-key-redacted-for-test"}',
      "Authorization: Bearer bearer-token-redacted-for-test",
      "Proxy-Authorization: Basic proxy-token-redacted-for-test",
      "-----BEGIN PRIVATE KEY-----\nredacted\n-----END PRIVATE KEY-----",
    ].join(" ")

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toContain("[REDACTED]")
    expect(sanitized).not.toContain("slack-token-redacted-for-test")
    expect(sanitized).not.toContain("github-token-redacted-for-test")
    expect(sanitized).not.toContain("anthropic-key-redacted-for-test")
    expect(sanitized).not.toContain("google-key-redacted-for-test")
    expect(sanitized).not.toContain("bearer-token-redacted-for-test")
    expect(sanitized).not.toContain("proxy-token-redacted-for-test")
    expect(sanitized).not.toContain("BEGIN PRIVATE KEY")
  })

  test("#given JSON-style secret fields #when sanitizing #then values are redacted", () => {
    // given
    const input = '{"password":"hunter2","access_token":"abc123","Authorization":"Bearer secret-token","Cookie":"session=abc"}'

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toContain("[REDACTED]")
    expect(sanitized).not.toContain("hunter2")
    expect(sanitized).not.toContain("abc123")
    expect(sanitized).not.toContain("secret-token")
    expect(sanitized).not.toContain("session=abc")
  })

  test("#given authorization headers without schemes #when sanitizing #then complete values are redacted", () => {
    // given
    const input = '{"Authorization":"secret-token","Proxy-Authorization":"proxy secret token"}'

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toContain("[REDACTED]")
    expect(sanitized).not.toContain("secret-token")
    expect(sanitized).not.toContain("proxy secret token")
  })

  test("#given raw authorization headers with spaced values #when sanitizing #then suffix tokens do not leak", () => {
    // given
    const input = [
      "Authorization: ApiKey secret-token",
      "Proxy-Authorization: Digest username=foo, response=bar",
      "Authorization: secret token",
      "Proxy-Authorization: proxy secret token",
      "X-Request-ID: visible",
    ].join(" ")

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toContain("Authorization: [REDACTED]")
    expect(sanitized).toContain("Proxy-Authorization: [REDACTED]")
    expect(sanitized).toContain("X-Request-ID: visible")
    expect(sanitized).not.toContain("secret-token")
    expect(sanitized).not.toContain("username=foo")
    expect(sanitized).not.toContain("response=bar")
    expect(sanitized).not.toContain("secret token")
    expect(sanitized).not.toContain("proxy secret token")
  })

  test('#given quote-wrapped raw authorization header #when sanitizing #then wrapper is preserved without secret leak', () => {
    // given
    const input = 'error="Authorization: secret token"'

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toContain('error="Authorization: [REDACTED]"')
    expect(sanitized).not.toContain("secret token")
  })

  test("#given quote-wrapped raw proxy authorization header #when sanitizing #then suffix does not leak", () => {
    // given
    const input = 'message: "Proxy-Authorization: proxy secret token"'

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toContain('message: "Proxy-Authorization: [REDACTED]"')
    expect(sanitized).not.toContain("proxy secret token")
  })

  test("#given digest proxy authorization before another header #when sanitizing #then digest params are redacted and next header remains", () => {
    // given
    const input = 'Proxy-Authorization: Digest username="foo", response="bar" X-Request-ID: visible'

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toContain("Proxy-Authorization: [REDACTED]")
    expect(sanitized).toContain("X-Request-ID: visible")
    expect(sanitized).not.toContain("username")
    expect(sanitized).not.toContain("foo")
    expect(sanitized).not.toContain("response")
    expect(sanitized).not.toContain("bar")
  })

  test("#given escaped digest proxy authorization params #when sanitizing #then every auth param is redacted", () => {
    // given
    const input = 'message: "Proxy-Authorization: Digest username=\\"foo\\", response=\\"bar\\""'

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toContain("Proxy-Authorization: [REDACTED]")
    expect(sanitized).not.toContain("foo")
    expect(sanitized).not.toContain("response")
    expect(sanitized).not.toContain("bar")
  })

  test("#given escaped digest proxy authorization before another header #when sanitizing #then next header remains without auth leaks", () => {
    // given
    const input = 'message: "Proxy-Authorization: Digest username=\\"foo\\", response=\\"bar\\" X-Request-ID: visible"'

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toContain("Proxy-Authorization: [REDACTED]")
    expect(sanitized).toContain("X-Request-ID: visible")
    expect(sanitized).not.toContain("foo")
    expect(sanitized).not.toContain("response")
    expect(sanitized).not.toContain("bar")
  })

  test("#given raw quote-wrapped authorization value before another header #when sanitizing #then quoted value is redacted", () => {
    // given
    const input = 'Authorization: "secret token" X-Request-ID: visible'

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toContain("Authorization: [REDACTED]")
    expect(sanitized).toContain("X-Request-ID: visible")
    expect(sanitized).not.toContain("secret token")
  })

  test("#given quoted authorization value containing header-like text #when sanitizing #then inner header text is redacted", () => {
    // given
    const input = 'Authorization: "secret X-Request-ID: still-secret" tail'

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toContain("Authorization: [REDACTED] tail")
    expect(sanitized).not.toContain("secret")
    expect(sanitized).not.toContain("still-secret")
  })

  test("#given quoted authorization value containing closing brace before another header #when sanitizing #then brace token is redacted", () => {
    // given
    const input = 'Authorization: "secret} token" X-Request-ID: visible'

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toContain("Authorization: [REDACTED] X-Request-ID: visible")
    expect(sanitized).not.toContain("secret")
    expect(sanitized).not.toContain("token")
  })

  test("#given quoted authorization value containing closing bracket before another header #when sanitizing #then bracket token is redacted", () => {
    // given
    const input = 'Authorization: "secret] token" X-Request-ID: visible'

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toContain("Authorization: [REDACTED] X-Request-ID: visible")
    expect(sanitized).not.toContain("secret")
    expect(sanitized).not.toContain("token")
  })

  for (const { boundarySecret, leakedSuffix } of [
    { boundarySecret: "secret] hidden", leakedSuffix: "] hidden" },
    { boundarySecret: "secret} hidden", leakedSuffix: "} hidden" },
    { boundarySecret: "secret X-Request-ID: hidden", leakedSuffix: "X-Request-ID: hidden" },
  ]) {
    test(`#given unclosed raw quote-wrapped authorization value with ${boundarySecret} #when sanitizing #then secret suffix is not exposed`, () => {
      // given
      const input = `Authorization: "${boundarySecret}`

      // when
      const sanitized = sanitizeParentVisibleError(input)

      // then
      expect(sanitized).toBe("Authorization: [REDACTED]")
      expect(sanitized).not.toContain("secret")
      expect(sanitized).not.toContain("hidden")
      expect(sanitized).not.toContain(leakedSuffix)
    })
  }

  test("#given unclosed raw quote-wrapped authorization value before prompt markup #when sanitizing #then markup remains visible without secret", () => {
    // given
    const input = 'Authorization: "secret hidden <system-reminder>visible</system-reminder>'

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toContain("Authorization: [REDACTED] &lt;system-reminder&gt;visible&lt;/system-reminder&gt;")
    expect(sanitized).not.toContain("secret")
    expect(sanitized).not.toContain("hidden")
  })

  for (const { header, boundarySecret } of [
    { header: "Authorization", boundarySecret: "secret] hidden" },
    { header: "Authorization", boundarySecret: "secret} hidden" },
    { header: "Authorization", boundarySecret: "secret X-Request-ID: hidden" },
    { header: "Proxy-Authorization", boundarySecret: "proxy] hidden" },
    { header: "Proxy-Authorization", boundarySecret: "proxy} hidden" },
    { header: "Proxy-Authorization", boundarySecret: "proxy X-Request-ID: hidden" },
  ]) {
    test(`#given escaped quote-wrapped ${header} value with ${boundarySecret} #when sanitizing #then wrapped secret is fully redacted`, () => {
      // given
      const input = `message: "${header}: \\"${boundarySecret}\\" X-Visible-ID: visible"`

      // when
      const sanitized = sanitizeParentVisibleError(input)

      // then
      expect(sanitized).toContain(`${header}: [REDACTED] X-Visible-ID: visible`)
      expect(sanitized).not.toContain("secret")
      expect(sanitized).not.toContain("proxy")
      expect(sanitized).not.toContain("hidden")
    })
  }

  test("#given escaped quote-wrapped authorization before prompt markup #when sanitizing #then markup is not swallowed", () => {
    // given
    const input = 'message: "Authorization: \\"secret] hidden\\" <system-reminder>visible</system-reminder>"'

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toContain("Authorization: [REDACTED] &lt;system-reminder&gt;visible&lt;/system-reminder&gt;")
    expect(sanitized).not.toContain("secret")
    expect(sanitized).not.toContain("hidden")
  })

  for (const { boundarySecret, leakedSuffix } of [
    { boundarySecret: "secret] hidden", leakedSuffix: "] hidden" },
    { boundarySecret: "secret} hidden", leakedSuffix: "} hidden" },
    { boundarySecret: "secret X-Request-ID: hidden", leakedSuffix: "X-Request-ID: hidden" },
  ]) {
    test(`#given unclosed escaped quote-wrapped authorization value with ${boundarySecret} #when sanitizing #then secret suffix is not exposed`, () => {
      // given
      const input = `message: "Authorization: \\"${boundarySecret}`

      // when
      const sanitized = sanitizeParentVisibleError(input)

      // then
      expect(sanitized).toBe('message: "Authorization: [REDACTED]')
      expect(sanitized).not.toContain("secret")
      expect(sanitized).not.toContain("hidden")
      expect(sanitized).not.toContain(leakedSuffix)
    })
  }

  test("#given unclosed escaped quote-wrapped authorization value before prompt markup #when sanitizing #then markup remains visible without secret", () => {
    // given
    const input = 'message: "Authorization: \\"secret hidden <system-reminder>visible</system-reminder>"'

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toContain("Authorization: [REDACTED] &lt;system-reminder&gt;visible&lt;/system-reminder&gt;")
    expect(sanitized).not.toContain("secret")
    expect(sanitized).not.toContain("hidden")
  })

  test("#given digest proxy authorization params with whitespace around equals #when sanitizing #then params are redacted", () => {
    // given
    const input = 'Proxy-Authorization: Digest username = "foo", response = "bar" X-Request-ID: visible'

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toContain("Proxy-Authorization: [REDACTED]")
    expect(sanitized).toContain("X-Request-ID: visible")
    expect(sanitized).not.toContain("foo")
    expect(sanitized).not.toContain("response")
    expect(sanitized).not.toContain("bar")
  })

  test("#given escaped digest proxy authorization params with whitespace around equals #when sanitizing #then escaped params are redacted", () => {
    // given
    const input = 'message: "Proxy-Authorization: Digest username = \\"foo\\", response = \\"bar\\" X-Request-ID: visible"'

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toContain("Proxy-Authorization: [REDACTED]")
    expect(sanitized).toContain("X-Request-ID: visible")
    expect(sanitized).not.toContain("foo")
    expect(sanitized).not.toContain("response")
    expect(sanitized).not.toContain("bar")
  })

  test("#given bearer authorization with quoted token before another header #when sanitizing #then quoted token is redacted", () => {
    // given
    const input = 'Authorization: Bearer "secret token" X-Request-ID: visible'

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toContain("Authorization: [REDACTED] X-Request-ID: visible")
    expect(sanitized).not.toContain("secret token")
  })

  test("#given proxy basic authorization with quoted token before another header #when sanitizing #then quoted token is redacted", () => {
    // given
    const input = 'Proxy-Authorization: Basic "proxy secret token" X-Request-ID: visible'

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toContain("Proxy-Authorization: [REDACTED] X-Request-ID: visible")
    expect(sanitized).not.toContain("proxy secret token")
  })

  for (const { input, leakedSecret } of [
    { input: 'Authorization: Bearer "bearer] hidden', leakedSecret: "bearer] hidden" },
    { input: 'Authorization: Bearer "bearer X-Request-ID: hidden', leakedSecret: "bearer X-Request-ID: hidden" },
    { input: 'Proxy-Authorization: Basic "proxy} hidden', leakedSecret: "proxy} hidden" },
    { input: 'Proxy-Authorization: Digest response="digest] hidden', leakedSecret: "digest] hidden" },
    {
      input: 'Proxy-Authorization: Digest username="secret X-Request-ID: hidden',
      leakedSecret: "secret X-Request-ID: hidden",
    },
  ]) {
    test(`#given raw unclosed inner authorization quote ${input} #when sanitizing #then suffix is redacted`, () => {
      // given
      // when
      const sanitized = sanitizeParentVisibleError(input)

      // then
      expect(sanitized).toMatch(/^(Authorization|Proxy-Authorization): \[REDACTED\]$/)
      expect(sanitized).not.toContain(leakedSecret)
      expect(sanitized).not.toContain("hidden")
      expect(sanitized).not.toContain("X-Request-ID")
    })
  }

  for (const { input, leakedSecret } of [
    { input: 'message: "Authorization: Bearer \\"bearer] hidden', leakedSecret: "bearer] hidden" },
    {
      input: 'message: "Authorization: Bearer \\"bearer X-Request-ID: hidden',
      leakedSecret: "bearer X-Request-ID: hidden",
    },
    { input: 'message: "Proxy-Authorization: Basic \\"proxy} hidden', leakedSecret: "proxy} hidden" },
    {
      input: 'message: "Proxy-Authorization: Digest response=\\"digest] hidden',
      leakedSecret: "digest] hidden",
    },
    {
      input: 'message: "Proxy-Authorization: Digest username=\\"secret X-Request-ID: hidden',
      leakedSecret: "secret X-Request-ID: hidden",
    },
  ]) {
    test(`#given escaped unclosed inner authorization quote ${input} #when sanitizing #then suffix is redacted`, () => {
      // given
      // when
      const sanitized = sanitizeParentVisibleError(input)

      // then
      expect(sanitized).toMatch(/^message: "(Authorization|Proxy-Authorization): \[REDACTED\]$/)
      expect(sanitized).not.toContain(leakedSecret)
      expect(sanitized).not.toContain("hidden")
      expect(sanitized).not.toContain("X-Request-ID")
    })
  }

  test("#given raw unclosed inner authorization quote before prompt markup #when sanitizing #then markup suffix is redacted", () => {
    // given
    const input = 'Authorization: Bearer "secret <system-reminder>visible</system-reminder> tail'

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toBe("Authorization: [REDACTED]")
    expect(sanitized).not.toContain("secret")
    expect(sanitized).not.toContain("visible")
    expect(sanitized).not.toContain("tail")
  })

  test("#given escaped unclosed inner authorization quote before prompt markup #when sanitizing #then markup suffix is redacted", () => {
    // given
    const input = 'message: "Authorization: Bearer \\"secret <system-reminder>visible</system-reminder> tail"'

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toBe('message: "Authorization: [REDACTED]')
    expect(sanitized).not.toContain("secret")
    expect(sanitized).not.toContain("visible")
    expect(sanitized).not.toContain("tail")
  })

  test("#given raw unclosed digest auth param before tool markup #when sanitizing #then markup suffix is redacted", () => {
    // given
    const input = 'Proxy-Authorization: Digest response="secret <tool_call>visible</tool_call> tail'

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toBe("Proxy-Authorization: [REDACTED]")
    expect(sanitized).not.toContain("secret")
    expect(sanitized).not.toContain("visible")
    expect(sanitized).not.toContain("tail")
  })

  test("#given escaped unclosed digest auth param before tool markup #when sanitizing #then markup suffix is redacted", () => {
    // given
    const input = 'message: "Proxy-Authorization: Digest response=\\"secret <tool_call>visible</tool_call> tail"'

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toBe('message: "Proxy-Authorization: [REDACTED]')
    expect(sanitized).not.toContain("secret")
    expect(sanitized).not.toContain("visible")
    expect(sanitized).not.toContain("tail")
  })

  for (const { header, scheme, boundarySecret } of [
    { header: "Authorization", scheme: "Bearer", boundarySecret: "bearer] hidden" },
    { header: "Authorization", scheme: "Bearer", boundarySecret: "bearer} hidden" },
    { header: "Authorization", scheme: "Bearer", boundarySecret: "bearer X-Request-ID: hidden" },
    { header: "Proxy-Authorization", scheme: "Basic", boundarySecret: "basic] hidden" },
    { header: "Proxy-Authorization", scheme: "Basic", boundarySecret: "basic} hidden" },
    { header: "Proxy-Authorization", scheme: "Basic", boundarySecret: "basic X-Request-ID: hidden" },
  ]) {
    test(`#given escaped ${scheme} quoted token with ${boundarySecret} #when sanitizing #then token is fully redacted`, () => {
      // given
      const input = `message: "${header}: ${scheme} \\"${boundarySecret}\\" X-Visible-ID: visible"`

      // when
      const sanitized = sanitizeParentVisibleError(input)

      // then
      expect(sanitized).toContain(`${header}: [REDACTED] X-Visible-ID: visible`)
      expect(sanitized).not.toContain("bearer")
      expect(sanitized).not.toContain("basic")
      expect(sanitized).not.toContain("hidden")
    })
  }

  test("#given escaped digest auth params with header-like quoted text #when sanitizing #then inner header text is redacted", () => {
    // given
    const input =
      'message: "Proxy-Authorization: Digest username=\\"user X-Request-ID: hidden\\", response=\\"digest-secret\\" X-Visible-ID: visible"'

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toContain("Proxy-Authorization: [REDACTED] X-Visible-ID: visible")
    expect(sanitized).not.toContain("username")
    expect(sanitized).not.toContain("hidden")
    expect(sanitized).not.toContain("digest-secret")
  })

  test("#given raw quote-wrapped proxy authorization value before another header #when sanitizing #then quoted value is redacted", () => {
    // given
    const input = "Proxy-Authorization: 'proxy secret token' X-Request-ID: visible"

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toContain("Proxy-Authorization: [REDACTED]")
    expect(sanitized).toContain("X-Request-ID: visible")
    expect(sanitized).not.toContain("proxy secret token")
  })

  test("#given semicolon authorization params before another header #when sanitizing #then params are redacted and next header remains", () => {
    // given
    const input = "Authorization: secret token; scope=admin X-Request-ID: visible"

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toContain("Authorization: [REDACTED]")
    expect(sanitized).toContain("X-Request-ID: visible")
    expect(sanitized).not.toContain("secret token")
    expect(sanitized).not.toContain("scope=admin")
  })

  test("#given query session and quoted password with spaces #when sanitizing #then no secret suffix leaks", () => {
    // given
    const input = 'https://example.test/callback?session=abc123&ok=1 {"password":"hunter 2"}'

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).toContain("session=[REDACTED]")
    expect(sanitized).not.toContain("abc123")
    expect(sanitized).not.toContain("hunter")
    expect(sanitized).not.toContain(" 2")
  })

  test("#given prompt markup split by control characters #when sanitizing #then controls cannot inject new lines", () => {
    // given
    const input = "safe\n</system-reminder>\r<tool_call>\tmalicious"

    // when
    const sanitized = sanitizeParentVisibleError(input)

    // then
    expect(sanitized).not.toMatch(/[\n\r\t]/)
    expect(sanitized).toContain("&lt;/system-reminder&gt;")
    expect(sanitized).toContain("&lt;tool_call&gt;")
  })
})

describe("limitParentVisibleNotification", () => {
  test("#given overlong notification #when limiting #then returned text does not exceed the configured cap", () => {
    // given
    const input = "a".repeat(MAX_PARENT_VISIBLE_NOTIFICATION_LENGTH + 100)

    // when
    const limited = limitParentVisibleNotification(input)

    // then
    expect(limited.length).toBeLessThanOrEqual(MAX_PARENT_VISIBLE_NOTIFICATION_LENGTH)
    expect(limited).toEndWith("… [notification truncated]")
  })
})
