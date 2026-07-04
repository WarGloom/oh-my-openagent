/// <reference types="bun-types" />

import { afterAll, describe, expect, mock, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

const getSystemMcpServerNamesMock = mock(() => new Set<string>())

const TEST_DIR = mkdtempSync(join(tmpdir(), "serena-availability-"))
const TEST_XDG = join(TEST_DIR, "xdg")

mock.module("../features/claude-code-mcp-loader", () => ({
  getSystemMcpServerNames: getSystemMcpServerNamesMock,
}))

const { isSerenaServerAvailable } = await import("./serena-availability")

describe("serena-availability", () => {
  test("returns false when no serena server is available", () => {
    mkdirSync(join(TEST_XDG, "opencode"), { recursive: true })
    process.env.XDG_CONFIG_HOME = TEST_XDG
    getSystemMcpServerNamesMock.mockReturnValue(new Set(["playwright", "websearch"]))

    expect(isSerenaServerAvailable()).toBe(false)
  })

  test("returns false when no MCP servers exist", () => {
    mkdirSync(join(TEST_XDG, "opencode"), { recursive: true })
    process.env.XDG_CONFIG_HOME = TEST_XDG
    getSystemMcpServerNamesMock.mockReturnValue(new Set())

    expect(isSerenaServerAvailable()).toBe(false)
  })

  test("returns true when system MCP names include serena", () => {
    getSystemMcpServerNamesMock.mockReturnValue(new Set(["serena"]))

    expect(isSerenaServerAvailable()).toBe(true)
  })

  test("returns true when system MCP names include serena (case-insensitive)", () => {
    getSystemMcpServerNamesMock.mockReturnValue(new Set(["Serena-MCP"]))

    expect(isSerenaServerAvailable()).toBe(true)
  })
})

afterAll(() => {
  delete process.env.XDG_CONFIG_HOME
  rmSync(TEST_DIR, { recursive: true, force: true })
})
