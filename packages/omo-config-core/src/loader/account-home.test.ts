import { describe, expect, test } from "bun:test"
import { selectAccountHome } from "./account-home"

describe("selectAccountHome", () => {
  const fallbackHome = () => "/isolated-home"
  const readPasswd = () => "root:x:0:0:root:/root:/bin/sh\nalice:x:1001:1001:Alice:/home/alice:/bin/sh"
  const options = { readPasswd, getuid: () => 1001, platform: "linux" as const, fallbackHome }

  test("prefers the passwd home over the overridden HOME fallback", () => {
    expect(selectAccountHome(options)).toBe("/home/alice")
  })

  test("uses the fallback when passwd cannot be read", () => {
    expect(
      selectAccountHome({
        ...options,
        readPasswd: () => {
          throw new Error("unavailable")
        },
      }),
    ).toBe("/isolated-home")
  })

  test("uses the fallback when getuid is unavailable", () => {
    expect(selectAccountHome({ ...options, getuid: undefined })).toBe("/isolated-home")
  })

  test("uses the fallback on Windows", () => {
    expect(selectAccountHome({ ...options, platform: "win32" })).toBe("/isolated-home")
  })

  test("uses the fallback when no uid matches", () => {
    expect(selectAccountHome({ ...options, getuid: () => 42 })).toBe("/isolated-home")
  })
})
