/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { _resetMemCacheForTesting as resetConnectedProvidersCacheForTesting } from "../../shared/connected-providers-cache"
import { releaseAllPromptAsyncReservationsForTesting } from "../../shared/prompt-async-gate"
import {
  getSessionAgent,
  _resetForTesting as resetClaudeCodeSessionState,
  subagentSessions,
} from "../claude-code-session-state"
import { BackgroundManager } from "./manager"
import { clearBackgroundTaskRegistryForTesting } from "./task-registry"

type SessionGetArgs = { readonly path: { readonly id: string } }
type SessionCreateArgs = {
  readonly body?: {
    readonly parentID?: string
    readonly model?: { readonly providerID?: string; readonly id?: string; readonly variant?: string }
  }
}
type PromptCall = { readonly path: { readonly id: string }; readonly body?: unknown }
type FallbackRetryResultRecord = { waitForOutputUntil?: number }

const originalXdgCacheHome = process.env.XDG_CACHE_HOME
const testDirectory = "/tmp/omo-atlas-fallback-test"
let cacheCounter = 0

beforeEach(() => {
  process.env.XDG_CACHE_HOME = `${testDirectory}/cache-${cacheCounter}`
  cacheCounter += 1
  resetConnectedProvidersCacheForTesting()
  resetClaudeCodeSessionState()
})

afterEach(() => {
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome
  }
  resetConnectedProvidersCacheForTesting()
  resetClaudeCodeSessionState()
  clearBackgroundTaskRegistryForTesting()
  releaseAllPromptAsyncReservationsForTesting()
})

function createPluginInput(client: unknown, directory: string): PluginInput {
  return { client, directory } as PluginInput
}

async function flushAsyncWork(cycles = 30): Promise<void> {
  for (let index = 0; index < cycles; index++) {
    await Promise.resolve()
  }
}

function createAtlasHarness(): {
  readonly manager: BackgroundManager
  readonly createdSessions: Array<{ readonly id: string; readonly body: SessionCreateArgs["body"] }>
  readonly promptCalls: PromptCall[]
  readonly markSessionMissing: (sessionID: string) => void
} {
  const directory = testDirectory
  const sessionAlive = new Map<string, boolean>([["atlas-parent", true]])
  const createdSessions: Array<{ readonly id: string; readonly body: SessionCreateArgs["body"] }> = []
  const promptCalls: PromptCall[] = []
  const sessionIDs = ["ses_primary", "ses_fallback"]

  const client = {
    session: {
      get: async ({ path }: SessionGetArgs) => {
        if (path.id === "atlas-parent") {
          return { data: { id: path.id, directory, parentID: undefined } }
        }
        if (sessionAlive.get(path.id)) {
          return { data: { id: path.id, directory, parentID: "atlas-parent" } }
        }
        return { error: { status: 404, message: `session ${path.id} not found` } }
      },
      create: async (args: SessionCreateArgs) => {
        const id = sessionIDs[createdSessions.length] ?? `ses_extra_${createdSessions.length}`
        createdSessions.push({ id, body: args.body })
        sessionAlive.set(id, true)
        return { data: { id } }
      },
      promptAsync: async (args: PromptCall) => {
        promptCalls.push(args)
        return {}
      },
      abort: async ({ path }: SessionGetArgs) => {
        sessionAlive.set(path.id, false)
        return {}
      },
    },
  }
  const manager = new BackgroundManager({ pluginContext: createPluginInput(client, directory) })

  return {
    manager,
    createdSessions,
    promptCalls,
    markSessionMissing: (sessionID: string) => sessionAlive.set(sessionID, false),
  }
}

async function launchAtlasOracleSubagent(manager: BackgroundManager): Promise<string> {
  const task = await manager.launch({
    description: "Atlas oracle subagent",
    prompt: "Investigate fallback behavior",
    agent: "oracle",
    parentSessionId: "atlas-parent",
    parentMessageId: "atlas-message",
    parentAgent: "atlas",
    model: { providerID: "openai", modelID: "gpt-5.5", variant: "high" },
    fallbackChain: [
      { providers: ["github-copilot"], model: "claude-sonnet-4.6", variant: "high" },
    ],
  })
  await flushAsyncWork()
  return task.id
}

function emitUsageLimitError(manager: BackgroundManager, sessionID: string): void {
  manager.handleEvent({
    type: "session.error",
    properties: {
      sessionID,
      error: {
        name: "AI_APICallError",
        data: {
          error: {
            type: "usage_limit_reached",
            message: "The usage limit has been reached",
          },
        },
      },
    },
  })
}

function expireFallbackOutputWait(manager: BackgroundManager, sessionID: string): void {
  const records = (manager as unknown as {
    fallbackRetryResultsBySession?: Map<string, FallbackRetryResultRecord>
  }).fallbackRetryResultsBySession
  const record = records?.get(sessionID)
  if (record) {
    record.waitForOutputUntil = Date.now() - 1
  }
}

describe("Atlas-spawned subagent runtime fallback", () => {
  test("continues oracle subagent in the same session on OpenAI usage_limit_reached", async () => {
    //#given
    const { manager, createdSessions, promptCalls } = createAtlasHarness()
    const taskID = await launchAtlasOracleSubagent(manager)

    //#when
    emitUsageLimitError(manager, "ses_primary")
    await flushAsyncWork(60)

    //#then
    const task = manager.getTask(taskID)
    expect(task?.status).toBe("running")
    expect(task?.sessionId).toBe("ses_primary")
    expect(task?.model).toEqual({ providerID: "github-copilot", modelID: "claude-sonnet-4.6", variant: "high" })
    expect(task?.attemptCount).toBe(1)
    expect(createdSessions).toHaveLength(1)
    expect(promptCalls).toHaveLength(2)
    expect(promptCalls[1]?.path.id).toBe("ses_primary")
    expect(promptCalls[1]?.body).toMatchObject({
      model: { providerID: "github-copilot", modelID: "claude-sonnet-4.6" },
      variant: "high",
    })
    expect(subagentSessions.has("ses_primary")).toBe(true)
    expect(getSessionAgent("ses_primary")).toBe("oracle")

    manager.shutdown()
  })

  test("surfaces non-retryable oracle subagent errors without creating a fallback session", async () => {
    //#given
    const { manager, createdSessions, markSessionMissing } = createAtlasHarness()
    const taskID = await launchAtlasOracleSubagent(manager)
    markSessionMissing("ses_primary")

    //#when
    manager.handleEvent({
      type: "session.error",
      properties: {
        sessionID: "ses_primary",
        error: { name: "PermissionDeniedError", data: { message: "permission denied" } },
      },
    })
    await flushAsyncWork(60)

    //#then
    const task = manager.getTask(taskID)
    expect(task?.status).toBe("error")
    expect(task?.error).toBe("permission denied")
    expect(createdSessions).toHaveLength(1)

    manager.shutdown()
  })

  test("marks oracle subagent errored when usage_limit_reached exhausts all fallbacks", async () => {
    //#given
    const { manager, createdSessions, markSessionMissing } = createAtlasHarness()
    const taskID = await launchAtlasOracleSubagent(manager)
    emitUsageLimitError(manager, "ses_primary")
    await flushAsyncWork(60)
    expireFallbackOutputWait(manager, "ses_primary")
    markSessionMissing("ses_primary")

    //#when
    emitUsageLimitError(manager, "ses_primary")
    await flushAsyncWork(60)

    //#then
    const task = manager.getTask(taskID)
    expect(task?.status).toBe("error")
    expect(task?.error).toBe("The usage limit has been reached")
    expect(task?.attemptCount).toBe(1)
    expect(createdSessions).toHaveLength(1)

    manager.shutdown()
  })
})
