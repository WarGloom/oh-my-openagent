import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { _resetForTesting, updateSessionAgent } from "../../features/claude-code-session-state"

const getSystemMcpServerNamesMock = mock(() => new Set<string>())

mock.module("../../features/claude-code-mcp-loader", () => ({
  getSystemMcpServerNames: getSystemMcpServerNamesMock,
}))

const { createSerenaNavigationGuardHook } = await import("./hook")

describe("serena-navigation-guard", () => {
  const sessionID = "ses_serena_guard"

  beforeEach(() => {
    _resetForTesting()
    getSystemMcpServerNamesMock.mockReset()
    getSystemMcpServerNamesMock.mockReturnValue(new Set(["serena"]))
  })

  afterEach(() => {
    _resetForTesting()
  })

  test("blocks manual navigation tools before Serena for enforced agents", async () => {
    const hook = createSerenaNavigationGuardHook()
    updateSessionAgent(sessionID, "explore")

    await expect(
      hook["tool.execute.before"]({
        tool: "grep",
        sessionID,
        callID: "call_1",
      })
    ).rejects.toThrow("Serena-first navigation policy")
  })

  test("includes the Serena reminder on the first blocked attempt", async () => {
    const hook = createSerenaNavigationGuardHook()
    updateSessionAgent(sessionID, "Sisyphus (Ultraworker)")

    await expect(
      hook["tool.execute.before"]({
        tool: "glob",
        sessionID,
        callID: "call_1",
      })
    ).rejects.toThrow("serena_find_file")
  })

  test("keeps blocking after successful Serena usage", async () => {
    const hook = createSerenaNavigationGuardHook()
    updateSessionAgent(sessionID, "oracle")

    await hook["tool.execute.after"](
      { tool: "serena_find_file", sessionID, callID: "call_serena" },
      { title: "ok", output: "/repo/src/file.ts", metadata: {} }
    )

    await expect(
      hook["tool.execute.before"]({
        tool: "read",
        sessionID,
        callID: "call_2",
      })
    ).rejects.toThrow("Serena-first navigation policy")
  })

  test("allows manual navigation after a failed Serena attempt", async () => {
    const hook = createSerenaNavigationGuardHook()
    updateSessionAgent(sessionID, "explore")

    await hook["tool.execute.after"](
      { tool: "serena_find_symbol", sessionID, callID: "call_serena" },
      { title: "error", output: "Error: symbol lookup failed", metadata: {} }
    )

    await expect(
      hook["tool.execute.before"]({
        tool: "grep",
        sessionID,
        callID: "call_2",
      })
    ).resolves.toBeUndefined()
  })

  test("does not enforce when Serena MCP is unavailable", async () => {
    getSystemMcpServerNamesMock.mockReturnValue(new Set(["playwright"]))
    const hook = createSerenaNavigationGuardHook()
    updateSessionAgent(sessionID, "explore")

    await expect(
      hook["tool.execute.before"]({
        tool: "grep",
        sessionID,
        callID: "call_1",
      })
    ).resolves.toBeUndefined()
  })

  test("does not enforce for excluded agents", async () => {
    const hook = createSerenaNavigationGuardHook()
    updateSessionAgent(sessionID, "librarian")

    await expect(
      hook["tool.execute.before"]({
        tool: "grep",
        sessionID,
        callID: "call_1",
      })
    ).resolves.toBeUndefined()
  })
})
