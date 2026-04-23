/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test"
import { detectErrorType, extractMessageIndex, extractUnavailableToolName } from "./detect-error-type"

describe("detectErrorType", () => {
  it("#given a tool_use/tool_result error #when detecting #then returns tool_result_missing", () => {
    //#given
    const error = { message: "tool_use block must be followed by tool_result" }

    //#when
    const result = detectErrorType(error)

    //#then
    expect(result).toBe("tool_result_missing")
  })

  it("#given a thinking block order error #when detecting #then returns thinking_block_order", () => {
    //#given
    const error = { message: "thinking must be the first block in the response" }

    //#when
    const result = detectErrorType(error)

    //#then
    expect(result).toBe("thinking_block_order")
  })

  it("#given a thinking disabled violation #when detecting #then returns thinking_disabled_violation", () => {
    //#given
    const error = { message: "thinking is disabled and cannot contain thinking blocks" }

    //#when
    const result = detectErrorType(error)

    //#then
    expect(result).toBe("thinking_disabled_violation")
  })

  it("#given an unrecognized error #when detecting #then returns null", () => {
    //#given
    const error = { message: "some random error" }

    //#when
    const result = detectErrorType(error)

    //#then
    expect(result).toBeNull()
  })

  it("#given a malformed error with circular references #when detecting #then returns null without crashing", () => {
    //#given
    const circular: Record<string, unknown> = {}
    circular.self = circular

    //#when
    const result = detectErrorType(circular)

    //#then
    expect(result).toBeNull()
  })

  it("#given a proxy error with non-standard structure #when detecting #then returns null without crashing", () => {
    //#given
    const proxyError = {
      data: "not-an-object",
      error: 42,
      nested: { deeply: { error: true } },
    }

    //#when
    const result = detectErrorType(proxyError)

    //#then
    expect(result).toBeNull()
  })

  it("#given a null error #when detecting #then returns null", () => {
    //#given
    const error = null

    //#when
    const result = detectErrorType(error)

    //#then
    expect(result).toBeNull()
  })

  it("#given an error with data.error containing message #when detecting #then extracts correctly", () => {
    //#given
    const error = {
      data: {
        error: {
          message: "tool_use block requires tool_result",
        },
      },
    }

    //#when
    const result = detectErrorType(error)

    //#then
    expect(result).toBe("tool_result_missing")
  })

  it("#given a dummy_tool unavailable tool error #when detecting #then returns unavailable_tool", () => {
    //#given
    const error = { message: "model tried to call unavailable tool 'invalid'" }

    //#when
    const result = detectErrorType(error)

    //#then
    expect(result).toBe("unavailable_tool")
  })

  it("#given a no such tool error #when detecting #then returns unavailable_tool", () => {
    //#given
    const error = { message: "No such tool: grepppp" }

    //#when
    const result = detectErrorType(error)

    //#then
    expect(result).toBe("unavailable_tool")
  })

  it("#given a NoSuchToolError token #when detecting #then returns unavailable_tool", () => {
    //#given
    const error = { message: "NoSuchToolError: no such tool invalid" }

    //#when
    const result = detectErrorType(error)

    //#then
    expect(result).toBe("unavailable_tool")
  })

  it("#given a dummy_tool token in nested error #when detecting #then returns unavailable_tool", () => {
    //#given
    const error = {
      data: {
        error: {
          message: "dummy_tool Model tried to call unavailable tool 'invalid'",
        },
      },
    }

    //#when
    const result = detectErrorType(error)

    //#then
    expect(result).toBe("unavailable_tool")
  })
})

describe("extractMessageIndex", () => {
  it("#given an error referencing messages.5 #when extracting #then returns 5", () => {
    //#given
    const error = { message: "Invalid value at messages.5: tool_result is required" }

    //#when
    const result = extractMessageIndex(error)

    //#then
    expect(result).toBe(5)
  })

  it("#given a malformed error #when extracting #then returns null without crashing", () => {
    //#given
    const circular: Record<string, unknown> = {}
    circular.self = circular

    //#when
    const result = extractMessageIndex(circular)

    //#then
    expect(result).toBeNull()
  })
})

describe("extractUnavailableToolName", () => {
  it("#given unavailable tool error with quoted tool name #when extracting #then returns tool name", () => {
    //#given
    const error = { message: "model tried to call unavailable tool 'invalid'" }

    //#when
    const result = extractUnavailableToolName(error)

    //#then
    expect(result).toBe("invalid")
  })

  it("#given unavailable tool error with available-tools list #when underscore count differs #then returns matching available tool", () => {
    //#given
    const error = {
      message: "invalid [tool=serena__get_symbols_overview, error=Model tried to call unavailable tool 'serena__get_symbols_overview'. Available tools: invalid, serena_get_symbols_overview, read]",
    }

    //#when
    const result = extractUnavailableToolName(error)

    //#then
    expect(result).toBe("serena_get_symbols_overview")
  })

  it("#given unavailable tool error without available-tools alias match #when extracting #then returns original tool name", () => {
    //#given
    const error = {
      message: "Model tried to call unavailable tool 'serena__missing_tool'. Available tools: invalid, read, grep",
    }

    //#when
    const result = extractUnavailableToolName(error)

    //#then
    expect(result).toBe("serena__missing_tool")
  })

  it("#given serena mcp alias with available serena tool #when extracting #then returns the canonical serena tool", () => {
    //#given
    const error = {
      message: "Model tried to call unavailable tool 'mcp__plugin_serena_serena__activate_project'. Available tools: invalid, serena_activate_project, read",
    }

    //#when
    const result = extractUnavailableToolName(error)

    //#then
    expect(result).toBe("serena_activate_project")
  })

  it("#given error without unavailable tool name #when extracting #then returns null", () => {
    //#given
    const error = { message: "dummy_tool appeared without tool name" }

    //#when
    const result = extractUnavailableToolName(error)

    //#then
    expect(result).toBeNull()
  })

  it("#given no such tool error with colon format #when extracting #then returns tool name", () => {
    //#given
    const error = { message: "No such tool: invalid_tool" }

    //#when
    const result = extractUnavailableToolName(error)

    //#then
    expect(result).toBe("invalid_tool")
  })
})
