import { describe, expect, test } from "bun:test"
import { tool } from "@opencode-ai/plugin"

import type { ToolsRecord } from "./types"
import { createToolRegistry, trimToolsToCap } from "./tool-registry"

const fakeTool = tool({
  description: "test tool",
  args: {},
  async execute(): Promise<string> {
    return "ok"
  },
})

describe("#given tool trimming prioritization", () => {
  test("#when max_tools trims a hashline edit registration named edit #then edit is removed before higher-priority tools", () => {
    const filteredTools = {
      bash: fakeTool,
      edit: fakeTool,
      read: fakeTool,
    } satisfies ToolsRecord

    trimToolsToCap(filteredTools, 2)

    expect(filteredTools).not.toHaveProperty("edit")
    expect(filteredTools).toHaveProperty("bash")
    expect(filteredTools).toHaveProperty("read")
  })
})

describe("#given max_tools cap and low-priority background tools", () => {
  test("#when background and background_cancel exceed cap #then they are removed before edit", () => {
    const filteredTools = {
      keep_one: fakeTool,
      keep_two: fakeTool,
      keep_three: fakeTool,
      edit: fakeTool,
      background_output: fakeTool,
      background_cancel: fakeTool,
    } satisfies ToolsRecord

    trimToolsToCap(filteredTools, 4)

    expect(filteredTools).not.toHaveProperty("background_output")
    expect(filteredTools).not.toHaveProperty("background_cancel")
    expect(filteredTools).toHaveProperty("edit")
    expect(filteredTools).toHaveProperty("keep_one")
    expect(filteredTools).toHaveProperty("keep_two")
    expect(filteredTools).toHaveProperty("keep_three")
  })
})

describe("#given background task aliases", () => {
  test("#when creating tool registry #then MCP-prefixed background tool names are registered", () => {
    const result = createToolRegistry({
      ctx: { directory: "/tmp" } as Parameters<typeof createToolRegistry>[0]["ctx"],
      pluginConfig: {},
      managers: {
        backgroundManager: {},
        tmuxSessionManager: {},
        skillMcpManager: {},
      } as Parameters<typeof createToolRegistry>[0]["managers"],
      skillContext: {
        mergedSkills: [],
        availableSkills: [],
        browserProvider: "playwright",
        disabledSkills: new Set(),
      },
      availableCategories: [],
    })

    expect(result.filteredTools).toHaveProperty("background_output")
    expect(result.filteredTools).toHaveProperty("mcp_background_output")
    expect(result.filteredTools).toHaveProperty("background_cancel")
    expect(result.filteredTools).toHaveProperty("mcp_background_cancel")
    expect(result.filteredTools["mcp_background_output"]).toBe(result.filteredTools["background_output"])
    expect(result.filteredTools["mcp_background_cancel"]).toBe(result.filteredTools["background_cancel"])
  })
})

describe("#given task_system configuration", () => {
  test("#when task_system is omitted #then task tools are not registered by default", () => {
    const result = createToolRegistry({
      ctx: { directory: "/tmp" } as Parameters<typeof createToolRegistry>[0]["ctx"],
      pluginConfig: {},
      managers: {
        backgroundManager: {},
        tmuxSessionManager: {},
        skillMcpManager: {},
      } as Parameters<typeof createToolRegistry>[0]["managers"],
      skillContext: {
        mergedSkills: [],
        availableSkills: [],
        browserProvider: "playwright",
        disabledSkills: new Set(),
      },
      availableCategories: [],
    })

    expect(result.taskSystemEnabled).toBe(false)
    expect(result.filteredTools).not.toHaveProperty("task_create")
    expect(result.filteredTools).not.toHaveProperty("task_get")
    expect(result.filteredTools).not.toHaveProperty("task_list")
    expect(result.filteredTools).not.toHaveProperty("task_update")
  })

  test("#when task_system is enabled #then task tools are registered", () => {
    const result = createToolRegistry({
      ctx: { directory: "/tmp" } as Parameters<typeof createToolRegistry>[0]["ctx"],
      pluginConfig: {
        experimental: { task_system: true },
      },
      managers: {
        backgroundManager: {},
        tmuxSessionManager: {},
        skillMcpManager: {},
      } as Parameters<typeof createToolRegistry>[0]["managers"],
      skillContext: {
        mergedSkills: [],
        availableSkills: [],
        browserProvider: "playwright",
        disabledSkills: new Set(),
      },
      availableCategories: [],
    })

    expect(result.taskSystemEnabled).toBe(true)
    expect(result.filteredTools).toHaveProperty("task_create")
    expect(result.filteredTools).toHaveProperty("task_get")
    expect(result.filteredTools).toHaveProperty("task_list")
    expect(result.filteredTools).toHaveProperty("task_update")
  })
})

describe("#given tmux integration is disabled", () => {
  test("#when system tmux is available #then interactive_bash remains registered", () => {
    const result = createToolRegistry({
      ctx: { directory: "/tmp" } as Parameters<typeof createToolRegistry>[0]["ctx"],
      pluginConfig: {
        tmux: {
          enabled: false,
          layout: "main-vertical",
          main_pane_size: 60,
          main_pane_min_width: 120,
          agent_pane_min_width: 40,
          isolation: "inline",
        },
      },
      managers: {
        backgroundManager: {},
        tmuxSessionManager: {},
        skillMcpManager: {},
      } as Parameters<typeof createToolRegistry>[0]["managers"],
      skillContext: {
        mergedSkills: [],
        availableSkills: [],
        browserProvider: "playwright",
        disabledSkills: new Set(),
      },
      availableCategories: [],
      interactiveBashEnabled: true,
    })

    expect(result.filteredTools).toHaveProperty("interactive_bash")
  })

  test("#when system tmux is unavailable #then interactive_bash is not registered", () => {
    const result = createToolRegistry({
      ctx: { directory: "/tmp" } as Parameters<typeof createToolRegistry>[0]["ctx"],
      pluginConfig: {
        tmux: {
          enabled: false,
          layout: "main-vertical",
          main_pane_size: 60,
          main_pane_min_width: 120,
          agent_pane_min_width: 40,
          isolation: "inline",
        },
      },
      managers: {
        backgroundManager: {},
        tmuxSessionManager: {},
        skillMcpManager: {},
      } as Parameters<typeof createToolRegistry>[0]["managers"],
      skillContext: {
        mergedSkills: [],
        availableSkills: [],
        browserProvider: "playwright",
        disabledSkills: new Set(),
      },
      availableCategories: [],
      interactiveBashEnabled: false,
    })

    expect(result.filteredTools).not.toHaveProperty("interactive_bash")
  })
})
