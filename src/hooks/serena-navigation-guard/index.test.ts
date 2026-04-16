import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { _resetForTesting, updateSessionAgent } from "../../features/claude-code-session-state"
import { clearSessionTools, setSessionTools } from "../../shared/session-tools-store"

const messagesMock = mock(async () => ({ data: [] }))

const { createSerenaNavigationGuardHook } = await import("./hook")

describe("serena-navigation-guard", () => {
  const sessionID = "ses_serena_guard"

  beforeEach(() => {
    _resetForTesting()
    messagesMock.mockReset()
    messagesMock.mockResolvedValue({ data: [] })
    clearSessionTools()
    setSessionTools(sessionID, {
      serena_find_file: true,
      serena_find_symbol: true,
      serena_check_onboarding_performed: true,
    })
  })

  afterEach(() => {
    _resetForTesting()
    clearSessionTools()
  })

  test("blocks manual navigation tools before Serena for enforced agents", async () => {
    const hook = createSerenaNavigationGuardHook({ client: { session: { messages: messagesMock } } })
    updateSessionAgent(sessionID, "oracle")

    await expect(
      hook["tool.execute.before"]({
        tool: "grep",
        sessionID,
        callID: "call_1",
      }, { args: {} })
    ).rejects.toThrow("Serena-first navigation policy")
  })

  test("includes the Serena reminder on the first blocked attempt", async () => {
    const hook = createSerenaNavigationGuardHook({ client: { session: { messages: messagesMock } } })
    updateSessionAgent(sessionID, "Sisyphus (Ultraworker)")

    await expect(
      hook["tool.execute.before"]({
        tool: "glob",
        sessionID,
        callID: "call_1",
      }, { args: {} })
    ).rejects.toThrow("serena_find_file")
  })

  test("keeps blocking after successful Serena usage", async () => {
    const hook = createSerenaNavigationGuardHook({ client: { session: { messages: messagesMock } } })
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
      }, { args: {} })
    ).rejects.toThrow("Serena-first navigation policy")
  })

  test("allows direct read for obvious non-code files", async () => {
    const hook = createSerenaNavigationGuardHook({ client: { session: { messages: messagesMock } } })
    updateSessionAgent(sessionID, "oracle")

    await expect(
      hook["tool.execute.before"]({
        tool: "read",
        sessionID,
        callID: "call_non_code_read",
      }, { args: { filePath: "/repo/TECH_DEBT_AUDIT.md" } })
    ).resolves.toBeUndefined()
  })

  test("allows manual navigation after a failed Serena attempt", async () => {
    const hook = createSerenaNavigationGuardHook({ client: { session: { messages: messagesMock } } })
    updateSessionAgent(sessionID, "oracle")

    await hook["tool.execute.after"](
      { tool: "serena_find_symbol", sessionID, callID: "call_serena" },
      { title: "error", output: "Error: symbol lookup failed", metadata: {} }
    )

    await expect(
      hook["tool.execute.before"]({
        tool: "grep",
        sessionID,
        callID: "call_2",
      }, { args: {} })
    ).resolves.toBeUndefined()
  })

  test("re-enables Serena-first blocking after a successful Serena call resets circuit breaker", async () => {
    const hook = createSerenaNavigationGuardHook({ client: { session: { messages: messagesMock } } })
    updateSessionAgent(sessionID, "oracle")

    await expect(
      hook["tool.execute.before"]({
        tool: "grep",
        sessionID,
        callID: "call_1",
      }, { args: {} })
    ).rejects.toThrow("Serena-first navigation policy")

    await expect(
      hook["tool.execute.before"]({
        tool: "grep",
        sessionID,
        callID: "call_2",
      }, { args: {} })
    ).rejects.toThrow("Serena-first navigation policy")

    await expect(
      hook["tool.execute.before"]({
        tool: "grep",
        sessionID,
        callID: "call_3",
      }, { args: {} })
    ).rejects.toThrow("Serena-first navigation policy")

    await expect(
      hook["tool.execute.before"]({
        tool: "grep",
        sessionID,
        callID: "call_4",
      }, { args: {} })
    ).resolves.toBeUndefined()

    await hook["tool.execute.after"](
      { tool: "serena_find_symbol", sessionID, callID: "call_serena_success" },
      { title: "ok", output: "found symbol", metadata: {} }
    )

    await expect(
      hook["tool.execute.before"]({
        tool: "grep",
        sessionID,
        callID: "call_5",
      }, { args: {} })
    ).rejects.toThrow("Serena-first navigation policy")
  })

  test("re-enables Serena-first blocking after a later successful Serena call clears failed fallback", async () => {
    const hook = createSerenaNavigationGuardHook({ client: { session: { messages: messagesMock } } })
    updateSessionAgent(sessionID, "oracle")

    await hook["tool.execute.after"](
      { tool: "serena_find_symbol", sessionID, callID: "call_serena_fail" },
      { title: "error", output: "Error: symbol lookup failed", metadata: {} }
    )

    await expect(
      hook["tool.execute.before"]({
        tool: "read",
        sessionID,
        callID: "call_allowed_after_failure",
      }, { args: {} })
    ).resolves.toBeUndefined()

    await hook["tool.execute.after"](
      { tool: "serena_find_symbol", sessionID, callID: "call_serena_success" },
      { title: "ok", output: "found symbol", metadata: {} }
    )

    await expect(
      hook["tool.execute.before"]({
        tool: "read",
        sessionID,
        callID: "call_blocked_after_success",
      }, { args: {} })
    ).rejects.toThrow("Serena-first navigation policy")
  })

  test("does not enforce for explore agent (excluded)", async () => {
    const hook = createSerenaNavigationGuardHook({ client: { session: { messages: messagesMock } } })
    updateSessionAgent(sessionID, "explore")

    await expect(
      hook["tool.execute.before"]({
        tool: "grep",
        sessionID,
        callID: "call_1",
      }, { args: {} })
    ).resolves.toBeUndefined()
  })

  test("treats MCP-style Serena text errors as failed attempts", async () => {
    const hook = createSerenaNavigationGuardHook({ client: { session: { messages: messagesMock } } })
    updateSessionAgent(sessionID, "oracle")

    await expect(
      Reflect.apply(hook["tool.execute.after"], hook, [
        { tool: "serena_check_onboarding_performed", sessionID, callID: "call_serena" },
        {
          content: [
            {
              type: "text",
              text: "Error: onboarding check failed",
            },
          ],
        },
      ])
    ).resolves.toBeUndefined()

    await expect(
      hook["tool.execute.before"]({
        tool: "read",
        sessionID,
        callID: "call_2",
      }, { args: {} })
    ).resolves.toBeUndefined()
  })

  test("does not enforce when Serena MCP is unavailable", async () => {
    clearSessionTools()
    setSessionTools(sessionID, { grep: true, read: true })
    const hook = createSerenaNavigationGuardHook({ client: { session: { messages: messagesMock } } })
    updateSessionAgent(sessionID, "oracle")

    await expect(
      hook["tool.execute.before"]({
        tool: "grep",
        sessionID,
        callID: "call_1",
      }, { args: {} })
    ).resolves.toBeUndefined()
  })

  test("does not enforce for excluded agents", async () => {
    const hook = createSerenaNavigationGuardHook({ client: { session: { messages: messagesMock } } })
    updateSessionAgent(sessionID, "librarian")

    await expect(
      hook["tool.execute.before"]({
        tool: "grep",
        sessionID,
        callID: "call_1",
      }, { args: {} })
    ).resolves.toBeUndefined()
  })

  test("loads Serena tool availability from session messages when cache is empty", async () => {
    clearSessionTools()
    messagesMock.mockImplementationOnce(async () => ({
      data: [
        {
          info: {
            tools: {
              serena_find_file: true,
              grep: true,
            },
          },
        },
      ],
    } as never))
    const hook = createSerenaNavigationGuardHook({ client: { session: { messages: messagesMock } } })
    updateSessionAgent(sessionID, "oracle")

    await expect(
      hook["tool.execute.before"]({
        tool: "grep",
        sessionID,
        callID: "call_from_messages",
      }, { args: {} })
    ).rejects.toThrow("Serena-first navigation policy")
  })
})
