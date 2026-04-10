/// <reference types="bun-types" />

import { describe, expect, mock, test } from "bun:test"

const getSystemMcpServerNamesMock = mock(() => new Set<string>())

mock.module("../features/claude-code-mcp-loader", () => ({
  getSystemMcpServerNames: getSystemMcpServerNamesMock,
}))

const { isSerenaServerAvailable } = await import("./serena-availability")

describe("serena-availability", () => {
  test("returns true when system MCP names include serena", () => {
    getSystemMcpServerNamesMock.mockReturnValue(new Set(["serena"]))

    expect(isSerenaServerAvailable()).toBe(true)
  })

  test("returns true when system MCP names include serena (case-insensitive)", () => {
    getSystemMcpServerNamesMock.mockReturnValue(new Set(["Serena-MCP"]))

    expect(isSerenaServerAvailable()).toBe(true)
  })

  test("returns false when no serena server is available", () => {
    getSystemMcpServerNamesMock.mockReturnValue(new Set(["playwright", "websearch"]))

    expect(isSerenaServerAvailable()).toBe(false)
  })

  test("returns false when no MCP servers exist", () => {
    getSystemMcpServerNamesMock.mockReturnValue(new Set())

    expect(isSerenaServerAvailable()).toBe(false)
  })
})
