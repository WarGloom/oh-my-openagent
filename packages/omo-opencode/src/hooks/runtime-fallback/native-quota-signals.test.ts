import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { createNativeQuotaSignals } from "./native-quota-signals"

const now = Date.parse("2026-11-06T10:00:00Z")
afterEach(() => mock.restore())

function response(
  providerID: string,
  headers: Record<string, string>,
  status = 200,
  origin = `https://api.${providerID}.com`,
) {
  return {
    connectionKey: "credential:a",
    model: { providerID, id: "one" },
    request: new Request(`${origin}/v1/messages`),
    response: new Response("stream", { status, headers }),
  }
}

describe("native quota signals", () => {
  test.each(["requests", "tokens", "project-tokens"])(
    "records an exact OpenAI %s zero until its documented compound reset",
    (counter) => {
      const clock = spyOn(Date, "now").mockReturnValue(now)
      const store = createNativeQuotaSignals()
      store.observe(
        response("openai", { [`x-ratelimit-remaining-${counter}`]: "0", [`x-ratelimit-reset-${counter}`]: "6m0s" }),
      )
      expect(store.unavailable("credential:a")).toEqual(new Set(["openai/one"]))
      clock.mockReturnValue(now + 360_000)
      expect(store.unavailable("credential:a")).toEqual(new Set())
    },
  )

  test("records only the exact Anthropic requests counter", () => {
    spyOn(Date, "now").mockReturnValue(now)
    const store = createNativeQuotaSignals()
    store.observe(
      response("anthropic", {
        "anthropic-ratelimit-tokens-remaining": "0",
        "anthropic-ratelimit-tokens-reset": "2026-11-06T11:00:00Z",
      }),
    )
    expect(store.unavailable("credential:a")).toEqual(new Set())
    store.observe(
      response("anthropic", {
        "anthropic-ratelimit-requests-remaining": "0",
        "anthropic-ratelimit-requests-reset": "2026-11-06T11:00:00Z",
      }),
    )
    expect(store.unavailable("credential:a")).toEqual(new Set(["anthropic/one"]))
  })

  const ignored: Array<{ headers: Record<string, string>; status: number; origin: string }> = [
    { headers: {}, status: 200, origin: "https://api.openai.com" },
    {
      headers: { "x-ratelimit-remaining-requests": "1", "x-ratelimit-reset-requests": "1s" },
      status: 200,
      origin: "https://api.openai.com",
    },
    {
      headers: { "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "bad" },
      status: 200,
      origin: "https://api.openai.com",
    },
    {
      headers: { "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "1s" },
      status: 429,
      origin: "https://api.openai.com",
    },
    {
      headers: { "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "1s" },
      status: 200,
      origin: "https://other.example",
    },
    {
      headers: {
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-reset-requests": "1s",
        "x-codex-plan-type": "plus",
      },
      status: 200,
      origin: "https://api.openai.com",
    },
  ]
  test.each(ignored)("ignores unsupported or nonauthoritative observations", ({ headers, status, origin }) => {
    spyOn(Date, "now").mockReturnValue(now)
    const store = createNativeQuotaSignals()
    store.observe(response("openai", headers, status, origin))
    expect(store.unavailable("credential:a")).toEqual(new Set())
  })

  test("does not shorten an active reset on a later positive or shorter observation", () => {
    const clock = spyOn(Date, "now").mockReturnValue(now)
    const store = createNativeQuotaSignals()
    store.observe(response("openai", { "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "6m0s" }))
    store.observe(response("openai", { "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "1s" }))
    store.observe(response("openai", { "x-ratelimit-remaining-requests": "10" }))
    clock.mockReturnValue(now + 2_000)
    expect(store.unavailable("credential:a")).toEqual(new Set(["openai/one"]))
    clock.mockReturnValue(now + 360_000)
    expect(store.unavailable("credential:a")).toEqual(new Set())
  })
})
