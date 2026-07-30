/// <reference types="bun-types" />

declare const require: NodeJS.Require

import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SkillMcpManager } from "../../../features/skill-mcp-manager"
import { clearSkillCache } from "../../../features/opencode-skill-loader/skill-content"
import type { LoadedSkill } from "../../../features/opencode-skill-loader/types"
import type { CommandInfo } from "../../slashcommand/types"
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js"
import { unsafeTestValue } from "../../../../../../test-support/unsafe-test-value"

const originalReadFileSync = fs.readFileSync.bind(fs)

type SkillToolOptions = Omit<Parameters<typeof import("../tools").createSkillTool>[0], "directory"> & {
  directory?: string
}
type CreateTestSkillTool = (options?: SkillToolOptions) => ReturnType<typeof import("../tools").createSkillTool>

let createSkillTool: CreateTestSkillTool

function clearRequireCache(modulePath: string): void {
  const resolvedPath = require.resolve(modulePath)
  if (require.cache?.[resolvedPath]) {
    delete require.cache[resolvedPath]
  }
}

function requireFresh<TModule>(modulePath: string): TModule {
  clearRequireCache(modulePath)
  return require(modulePath) as TModule
}

beforeEach(() => {
  mock.restore()
  clearSkillCache()
  clearRequireCache("../tools")
  clearRequireCache("../../../features/opencode-skill-loader/skill-content")
  clearRequireCache("../../slashcommand/command-discovery")

  mock.module("node:fs", () => ({
    ...fs,
    readFileSync: (path: string, encoding?: string) => {
      if (typeof path === "string" && path.includes("/skills/")) {
        return `---
description: Test skill description
---
Test skill body content`
      }
      return originalReadFileSync(path, encoding as BufferEncoding)
    },
  }))

  const loadedCreateSkillTool = requireFresh<typeof import("../tools")>("../tools").createSkillTool
  createSkillTool = (options = {}) => loadedCreateSkillTool({ directory: "/test", ...options })
})

afterAll(() => {
  mock.restore()
})

function createMockSkill(name: string, options: { agent?: string } = {}): LoadedSkill {
  return {
    name,
    path: join("/test", "skills", name, "SKILL.md"),
    resolvedPath: join("/test", "skills", name),
    definition: {
      name,
      description: `Test skill ${name}`,
      template: "Test template",
      agent: options.agent,
    },
    scope: "opencode-project",
  }
}

function createMockSkillWithMcp(name: string, mcpServers: Record<string, unknown>): LoadedSkill {
  return {
    name,
    path: join("/test", "skills", name, "SKILL.md"),
    resolvedPath: join("/test", "skills", name),
    definition: {
      name,
      description: `Test skill ${name}`,
      template: "Test template",
    },
    scope: "opencode-project",
    mcpConfig: mcpServers as LoadedSkill["mcpConfig"],
  }
}

const mockContext: ToolContext = {
  sessionID: "test-session",
  messageID: "msg-1",
  agent: "test-agent",
  directory: join(tmpdir(), "zauc-mock-opencode"),
  worktree: join(tmpdir(), "zauc-mock-opencode"),
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
}

describe("skill tool - synchronous description", () => {
  it("omits pre-provided skills from available_items by default", () => {
    // given
    const loadedSkills = [createMockSkill("test-skill")]

    // when
    const tool = createSkillTool({ skills: loadedSkills })

    // then
    expect(tool.description).not.toContain("<available_items>")
    expect(tool.description).not.toContain("test-skill")
  })

  it("includes all pre-provided skills in available_items when explicitly requested", () => {
    // given
    const loadedSkills = [
      createMockSkill("playwright"),
      createMockSkill("frontend"),
      createMockSkill("git-master"),
    ]

    // when
    const tool = createSkillTool({
      skills: loadedSkills,
      includeSkillsInDescription: true,
    })

    // then
    expect(tool.description).toContain("<available_items>")
    expect(tool.description).toContain("playwright")
    expect(tool.description).toContain("frontend")
    expect(tool.description).toContain("git-master")
  })

  it("shows no-skills message immediately when empty skills are pre-provided", () => {
    // given / #when
    const tool = createSkillTool({ skills: [] })

    // then
    expect(tool.description).toContain("No skills are currently available")
  })
})

describe("skill tool - agent restriction", () => {
  it("allows skill without agent restriction to any agent", async () => {
    // given
    const loadedSkills = [createMockSkill("public-skill")]
    const tool = createSkillTool({ skills: loadedSkills })
    const context = { ...mockContext, agent: "any-agent" }

    // when
    const result = await tool.execute({ name: "public-skill" }, context)

    // then
    expect(result).toContain("public-skill")
  })

  it("requests host skill permission before loading the skill", async () => {
    // given
    const loadedSkills = [createMockSkill("review-work")]
    const askCalls: Array<Parameters<ToolContext["ask"]>[0]> = []
    const tool = createSkillTool({ skills: loadedSkills })
    const context: ToolContext = {
      ...mockContext,
      ask: async (input) => {
        askCalls.push(input)
      },
    }

    // when
    await tool.execute({ name: "review-work" }, context)

    // then
    expect(askCalls).toEqual([
      {
        permission: "skill",
        patterns: ["review-work"],
        always: ["review-work"],
        metadata: { skill: "review-work" },
      },
    ])
  })

  it("allows skill when agent matches restriction", async () => {
    // given
    const loadedSkills = [createMockSkill("restricted-skill", { agent: "sisyphus" })]
    const tool = createSkillTool({ skills: loadedSkills })
    const context = { ...mockContext, agent: "sisyphus" }

    // when
    const result = await tool.execute({ name: "restricted-skill" }, context)

    // then
    expect(result).toContain("restricted-skill")
  })

  it("throws error when agent does not match restriction", async () => {
    // given
    const loadedSkills = [createMockSkill("sisyphus-only-skill", { agent: "sisyphus" })]
    const tool = createSkillTool({ skills: loadedSkills })
    const context = { ...mockContext, agent: "oracle" }

    // when / #then
    return expect(tool.execute({ name: "sisyphus-only-skill" }, context)).rejects.toThrow(
      'Skill "sisyphus-only-skill" is restricted to agent "sisyphus"'
    )
  })

  it("throws error when context agent is undefined for restricted skill", async () => {
    // given
    const loadedSkills = [createMockSkill("sisyphus-only-skill", { agent: "sisyphus" })]
    const tool = createSkillTool({ skills: loadedSkills })
    const contextWithoutAgent = { ...mockContext, agent: unsafeTestValue<string>(undefined) }

    // when / #then
    return expect(tool.execute({ name: "sisyphus-only-skill" }, contextWithoutAgent)).rejects.toThrow(
      'Skill "sisyphus-only-skill" is restricted to agent "sisyphus"'
    )
  })
})

describe("skill tool - MCP schema display", () => {
  let manager: SkillMcpManager
  let loadedSkills: LoadedSkill[]
  let sessionID: string

  beforeEach(() => {
    manager = new SkillMcpManager()
    loadedSkills = []
    sessionID = "test-session-1"
  })

  describe("formatMcpCapabilities with inputSchema", () => {
    it("uses the tool context sessionID when the fallback getter is empty", async () => {
      // given
      loadedSkills = [
        createMockSkillWithMcp("test-skill", {
          playwright: { command: "npx", args: ["-y", "@anthropic-ai/mcp-playwright"] },
        }),
      ]

      const listToolsSpy = spyOn(manager, "listTools").mockResolvedValue([])
      spyOn(manager, "listResources").mockResolvedValue([])
      spyOn(manager, "listPrompts").mockResolvedValue([])

      const tool = createSkillTool({
        skills: loadedSkills,
        mcpManager: manager,
        getSessionID: () => "",
      })

      // when
      await tool.execute({ name: "test-skill" }, mockContext)

      // then
      expect(listToolsSpy).toHaveBeenCalledWith(
        expect.objectContaining({ sessionID: mockContext.sessionID }),
        expect.any(Object),
      )
    })

    it("displays tool inputSchema when available", async () => {
      // given
      const mockToolsWithSchema: McpTool[] = [
        {
          name: "browser_type",
          description: "Type text into an element",
          inputSchema: {
            type: "object",
            properties: {
              element: { type: "string", description: "Human-readable element description" },
              ref: { type: "string", description: "Element reference from page snapshot" },
              text: { type: "string", description: "Text to type into the element" },
              submit: { type: "boolean", description: "Submit form after typing" },
            },
            required: ["element", "ref", "text"],
          },
        },
      ]

      loadedSkills = [
        createMockSkillWithMcp("test-skill", {
          playwright: { command: "npx", args: ["-y", "@anthropic-ai/mcp-playwright"] },
        }),
      ]

      // Mock manager.listTools to return our mock tools
      spyOn(manager, "listTools").mockResolvedValue(mockToolsWithSchema)
      spyOn(manager, "listResources").mockResolvedValue([])
      spyOn(manager, "listPrompts").mockResolvedValue([])

      const tool = createSkillTool({
        skills: loadedSkills,
        mcpManager: manager,
        getSessionID: () => sessionID,
      })

      // when
      const result = await tool.execute({ name: "test-skill" }, mockContext)

      // then
      // Should include inputSchema details
      expect(result).toContain("browser_type")
      expect(result).toContain("inputSchema")
      expect(result).toContain("element")
      expect(result).toContain("ref")
      expect(result).toContain("text")
      expect(result).toContain("submit")
      expect(result).toContain("required")
    })

    it("displays multiple tools with their schemas", async () => {
      // given
      const mockToolsWithSchema: McpTool[] = [
        {
          name: "browser_navigate",
          description: "Navigate to a URL",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string", description: "URL to navigate to" },
            },
            required: ["url"],
          },
        },
        {
          name: "browser_click",
          description: "Click an element",
          inputSchema: {
            type: "object",
            properties: {
              element: { type: "string" },
              ref: { type: "string" },
            },
            required: ["element", "ref"],
          },
        },
      ]

      loadedSkills = [
        createMockSkillWithMcp("playwright-skill", {
          playwright: { command: "npx", args: ["-y", "@anthropic-ai/mcp-playwright"] },
        }),
      ]

      spyOn(manager, "listTools").mockResolvedValue(mockToolsWithSchema)
      spyOn(manager, "listResources").mockResolvedValue([])
      spyOn(manager, "listPrompts").mockResolvedValue([])

      const tool = createSkillTool({
        skills: loadedSkills,
        mcpManager: manager,
        getSessionID: () => sessionID,
      })

      // when
      const result = await tool.execute({ name: "playwright-skill" }, mockContext)

      // then
      expect(result).toContain("browser_navigate")
      expect(result).toContain("browser_click")
      expect(result).toContain("url")
      expect(result).toContain("Navigate to a URL")
    })

    it("handles tools without inputSchema gracefully", async () => {
      // given
      const mockToolsMinimal: McpTool[] = [
        {
          name: "simple_tool",
          inputSchema: { type: "object" },
        },
      ]

      loadedSkills = [
        createMockSkillWithMcp("simple-skill", {
          simple: { command: "echo", args: ["test"] },
        }),
      ]

      spyOn(manager, "listTools").mockResolvedValue(mockToolsMinimal)
      spyOn(manager, "listResources").mockResolvedValue([])
      spyOn(manager, "listPrompts").mockResolvedValue([])

      const tool = createSkillTool({
        skills: loadedSkills,
        mcpManager: manager,
        getSessionID: () => sessionID,
      })

      // when
      const result = await tool.execute({ name: "simple-skill" }, mockContext)

      // then
      expect(result).toContain("simple_tool")
      // Should not throw, should handle gracefully
    })

    it("formats schema in a way LLM can understand for skill_mcp calls", async () => {
      // given
      const mockTools: McpTool[] = [
        {
          name: "query",
          description: "Execute SQL query",
          inputSchema: {
            type: "object",
            properties: {
              sql: { type: "string", description: "SQL query to execute" },
              params: { type: "array", description: "Query parameters" },
            },
            required: ["sql"],
          },
        },
      ]

      loadedSkills = [
        createMockSkillWithMcp("db-skill", {
          sqlite: { command: "uvx", args: ["mcp-server-sqlite"] },
        }),
      ]

      spyOn(manager, "listTools").mockResolvedValue(mockTools)
      spyOn(manager, "listResources").mockResolvedValue([])
      spyOn(manager, "listPrompts").mockResolvedValue([])

      const tool = createSkillTool({
        skills: loadedSkills,
        mcpManager: manager,
        getSessionID: () => sessionID,
      })

      // when
      const result = await tool.execute({ name: "db-skill" }, mockContext)

      // then
      // Should provide enough info for LLM to construct valid skill_mcp call
      expect(result).toContain("sqlite")
      expect(result).toContain("query")
      expect(result).toContain("sql")
      expect(result).toContain("required")
      expect(result).toMatch(/sql[\s\S]*string/i)
    })
  })
})

describe("skill tool - ordering and priority", () => {
  function createMockSkillWithScope(name: string, scope: string): LoadedSkill {
    return {
      name,
      path: join("/test", "skills", name, "SKILL.md"),
      resolvedPath: join("/test", "skills", name),
      definition: {
        name,
        description: `Test skill ${name}`,
        template: "Test template",
      },
      scope: scope as LoadedSkill["scope"],
    }
  }

  function createMockCommand(name: string, scope: string) {
    return {
      name,
      path: join("/test", "commands", `${name}.md`),
      metadata: {
        name,
        description: `Test command ${name}`,
      },
      scope: scope as CommandInfo["scope"],
    }
  }

  it("shows skills as command items with slash prefix in available_items", () => {
    //#given: mix of skills and commands
    const skills = [
      createMockSkillWithScope("builtin-skill", "builtin"),
      createMockSkillWithScope("project-skill", "project"),
    ]
    const commands = [
      createMockCommand("project-cmd", "project"),
      createMockCommand("builtin-cmd", "builtin"),
    ]

    //#when: creating tool with both
    const tool = createSkillTool({
      skills,
      commands,
      includeSkillsInDescription: true,
    })

    //#then: skills should appear as <command> items with / prefix, listed before regular commands
    const desc = tool.description
    expect(desc).toContain("<name>/builtin-skill</name>")
    expect(desc).toContain("<name>/project-skill</name>")
    expect(desc).not.toContain("<skill>")
    const skillCmdIndex = desc.indexOf("/project-skill")
    const regularCmdIndex = desc.indexOf("/project-cmd")
    expect(skillCmdIndex).toBeLessThan(regularCmdIndex)
  })

  it("sorts skill-commands by priority: project > user > opencode > builtin", () => {
    //#given: skills in random order
    const skills = [
      createMockSkillWithScope("builtin-skill", "builtin"),
      createMockSkillWithScope("opencode-skill", "opencode"),
      createMockSkillWithScope("user-skill", "user"),
      createMockSkillWithScope("project-skill", "project"),
    ]

    //#when: creating tool description with pre-provided skills
    const tool = createSkillTool({
      skills,
      includeSkillsInDescription: true,
    })

    //#then: expected ordering should follow scope priority
    const desc = tool.description
    const projectSkillIndex = desc.indexOf("<name>/project-skill</name>")
    const userSkillIndex = desc.indexOf("<name>/user-skill</name>")
    const opencodeSkillIndex = desc.indexOf("<name>/opencode-skill</name>")
    const builtinSkillIndex = desc.indexOf("<name>/builtin-skill</name>")

    expect(projectSkillIndex).toBeGreaterThan(-1)
    expect(userSkillIndex).toBeGreaterThan(-1)
    expect(opencodeSkillIndex).toBeGreaterThan(-1)
    expect(builtinSkillIndex).toBeGreaterThan(-1)

    expect(projectSkillIndex).toBeLessThan(userSkillIndex)
    expect(userSkillIndex).toBeLessThan(opencodeSkillIndex)
    expect(opencodeSkillIndex).toBeLessThan(builtinSkillIndex)
  })
})
