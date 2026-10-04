/// <reference types="bun-types" />

import { describe, expect, mock, test } from "bun:test"

import type { ToolContext } from "@opencode-ai/plugin/tool"
import { TeamModeConfigSchema } from "../../../config/schema/team-mode"
import type { OpencodeClient } from "../../../tools/delegate-task/types"

const mockClient = {} as OpencodeClient

let aggregateStatusImplementation: typeof import("../team-runtime/status").aggregateStatus = async () => {
  throw new Error("aggregateStatusImplementation not set")
}

let discoverTeamSpecsImplementation: typeof import("../team-registry/paths").discoverTeamSpecs = async () => {
  throw new Error("discoverTeamSpecsImplementation not set")
}

let loadTeamSpecImplementation: typeof import("../team-registry/loader").loadTeamSpec = async () => {
  throw new Error("loadTeamSpecImplementation not set")
}

let listActiveTeamsImplementation: typeof import("../team-state-store/store").listActiveTeams = async () => {
  throw new Error("listActiveTeamsImplementation not set")
}

const deps = {
  aggregateStatus: (...args: Parameters<typeof aggregateStatusImplementation>) => aggregateStatusImplementation(...args),
  discoverTeamSpecs: (...args: Parameters<typeof discoverTeamSpecsImplementation>) => discoverTeamSpecsImplementation(...args),
  loadTeamSpec: (...args: Parameters<typeof loadTeamSpecImplementation>) => loadTeamSpecImplementation(...args),
  listActiveTeams: (...args: Parameters<typeof listActiveTeamsImplementation>) => listActiveTeamsImplementation(...args),
}

import { createTeamListTool, createTeamStatusTool } from "./query"

function createMockContext(): ToolContext {
  return {
    sessionID: "session",
    messageID: "message",
    agent: "agent",
    directory: "/tmp/team-mode",
    worktree: "/tmp/team-mode",
    abort: new AbortController().signal,
    metadata: mock(() => {}),
    ask: async () => undefined,
  } satisfies ToolContext
}

describe("query tools", () => {
  test("team_status returns aggregated team status", async () => {
    // given
    const config = TeamModeConfigSchema.parse({ base_dir: "/tmp/team-mode" })
    const expectedStatus = {
      teamRunId: "team-run-1",
      teamName: "team-alpha",
      status: "active",
      createdAt: 1,
      members: [{ name: "worker", status: "running", unreadMessages: 0 }],
      removedMembers: Array.from({ length: 25 }, (_, index) => ({
        member: {
          name: `worker-${index}`,
          sessionId: `ses_archived_worker_${index}`,
          agentType: "general-purpose" as const,
          status: "completed" as const,
          subagent_type: "sisyphus-junior",
          category: "unspecified-low",
          model: { providerID: "openai", modelID: "gpt-6.1-sol", reasoningEffort: "medium", maxTokens: 32000 },
          worktreePath: `/tmp/opencode/team-worktrees/team-alpha/worker-${index}`,
          tmuxPaneId: `%${index + 10}`,
          tmuxGridPaneId: `%${index + 50}`,
          lastInjectedTurnMarker: `turn-${index}`,
          pendingInjectedMessageIds: Array.from({ length: 10 }, (_, message) => `message-${index}-${message}`),
          removalProtocolVersion: 1 as const,
        },
        operationId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        removedAt: 1791360000000 + index,
        requeuedTaskIds: Array.from({ length: 10 }, (_, task) => `task-${index}-${task}`),
      })),
      tasks: { pending: 0, claimed: 0, in_progress: 0, completed: 0, deleted: 0, total: 0 },
      shutdownRequests: [],
      concurrency: { runningOnSameModel: 0, queuedOnSameModel: 0 },
      bounds: { maxMembers: 8, maxParallelMembers: 4, maxMessagesPerRun: 10000, maxWallClockMinutes: 120, maxMemberTurns: 500 },
      staleLocks: [],
    } satisfies Awaited<ReturnType<typeof aggregateStatusImplementation>>
    aggregateStatusImplementation = async (teamRunId, passedConfig) => {
      expect(teamRunId).toBe("team-run-1")
      expect(passedConfig).toBe(config)
      return expectedStatus
    }
    const tool = createTeamStatusTool(config, mockClient, undefined, deps)

    // when
    const original = JSON.stringify(expectedStatus)
    const compact = await tool.execute({ teamRunId: "team-run-1" }, createMockContext())
    const explicitCompact = await tool.execute({ teamRunId: "team-run-1", includeRemovedDetails: false }, createMockContext())
    const detailed = await tool.execute({ teamRunId: "team-run-1", includeRemovedDetails: true }, createMockContext())

    // then
    expect(JSON.parse(compact)).toEqual({ ...expectedStatus, removedMembers: [], removedMemberCount: 25 })
    expect(explicitCompact).toBe(compact)
    expect(JSON.parse(detailed)).toEqual(expectedStatus)
    expect(JSON.stringify(expectedStatus)).toBe(original)
    const compactBytes = Buffer.byteLength(compact)
    const detailedBytes = Buffer.byteLength(detailed)
    expect(compactBytes).toBeLessThan(1500)
    expect(compactBytes).toBeLessThan(detailedBytes / 10)
    console.info(`team_status bytes: compact=${compactBytes}, detailed=${detailedBytes}`)
  })

  test("team_list includes declared-only teams", async () => {
    // given
    const config = TeamModeConfigSchema.parse({ base_dir: "/tmp/team-mode" })
    discoverTeamSpecsImplementation = async () => [
      { name: "foo", scope: "project", path: "/tmp/project/foo/config.json" },
    ]
    loadTeamSpecImplementation = async (teamName) => {
      expect(teamName).toBe("foo")
      return {
        version: 1,
        name: "foo",
        createdAt: 1,
        leadAgentId: "lead",
        members: [{ kind: "category", name: "member-a", category: "agent", prompt: "do", backendType: "in-process", isActive: true }],
      }
    }
    listActiveTeamsImplementation = async () => [
      { teamRunId: "run-1", teamName: "bar", status: "active", memberCount: 3, scope: "user" },
    ]
    const tool = createTeamListTool(config, mockClient, deps)

    // when
    const result = JSON.parse(await tool.execute({}, createMockContext()))

    // then
    expect(result).toEqual([
      { name: "foo", scope: "project", status: "not-started", teamRunId: undefined, memberCount: 1 },
      { name: "bar", scope: "user", status: "active", teamRunId: "run-1", memberCount: 3 },
    ])
  })
})
