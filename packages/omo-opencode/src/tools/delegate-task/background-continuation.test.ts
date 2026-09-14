/// <reference types="bun-types" />
const { describe, test, expect, mock } = require("bun:test")

describe("executeBackgroundContinuation - subagent metadata", () => {
  test("recovers an archived completed session synchronously without creating or deleting a session", async () => {
    const { archiveBackgroundTask, clearBackgroundTaskRegistryForTesting, claimRetainedSessionRecovery } = require("../../features/background-agent/task-registry")
    clearBackgroundTaskRegistryForTesting()
    const id = "ses_retained_recovery"
    archiveBackgroundTask({ id: "bg_retained", sessionId: id, parentSessionId: "parent-session", parentMessageId: "old", description: "retained", prompt: "old", agent: "sisyphus", status: "completed", model: { providerID: "test", modelID: "original", variant: "high", reasoningEffort: "high" } })
    let prompted = false
    const create = mock(() => { throw new Error("must not create") })
    const remove = mock(() => { throw new Error("must not delete") })
    const promptAsync = mock(async () => { prompted = true; return {} })
    const client = { session: {
      get: async () => ({ data: { id, parentID: "parent-session" } }),
      status: async () => ({ data: {} }),
      messages: async () => ({ data: prompted ? [{ info: { id: "msg-1", role: "user" }, parts: [] }, { info: { id: "msg-2", role: "assistant", finish: "stop", time: { completed: Date.now() } }, parts: [{ type: "text", text: "recovered-result" }] }] : [] }),
      promptAsync, create, delete: remove, abort: async () => ({}),
    } }
    const metadata = mock(async () => {})
    const { executeBackgroundContinuation } = require("./background-continuation")
    const result = await executeBackgroundContinuation({ task_id: id, prompt: "continue", description: "recover", run_in_background: true, load_skills: [] }, { sessionID: "parent-session", callID: "recovery-call", metadata, abort: new AbortController().signal }, { client, manager: { resume: async () => { throw new Error(`Task not found for session: ${id}`) } }, syncPollTimeoutMs: 4000 }, { sessionID: "parent-session", messageID: "current" }, "authorized skills")
    expect(result).toContain("Synchronous recovery")
    expect(result).toContain("recovered-result")
    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(promptAsync.mock.calls[0][0]).toMatchObject({ path: { id }, body: { agent: "sisyphus", model: { providerID: "test", modelID: "original" }, variant: "high", system: "authorized skills" } })
    expect(promptAsync.mock.calls[0][0].body.tools).toBeUndefined()
    expect(create).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(metadata.mock.calls.at(-1)[0].metadata).toMatchObject({ sync: true, run_in_background: false, sessionId: id })
    expect(metadata.mock.calls.at(-1)[0].metadata.backgroundTaskId).toBeUndefined()
    const claim = claimRetainedSessionRecovery(id, "parent-session")
    expect(() => claimRetainedSessionRecovery(id, "parent-session")).toThrow("claimed")
    claim.release()
    clearBackgroundTaskRegistryForTesting()
  })

  test("refuses unsafe archived-session recovery before prompting", async () => {
    const { archiveBackgroundTask, clearBackgroundTaskRegistryForTesting } = require("../../features/background-agent/task-registry")
    const { executeBackgroundContinuation } = require("./background-continuation")
    const id = "ses_unsafe_recovery"
    const promptAsync = mock(async () => ({}))
    for (const [kind, expected] of [["missing", "no owned completed task"], ["foreign", "no owned completed task"], ["cancelled", "no owned completed task"], ["busy", "SDK session is busy"], ["api-error", "Invalid"], ["wrong-sdk-parent", "Invalid"], ["status-api-error", "Invalid"]]) {
      clearBackgroundTaskRegistryForTesting()
      if (kind !== "missing") archiveBackgroundTask({ id: "bg_unsafe", sessionId: id, parentSessionId: kind === "foreign" ? "foreign" : "parent", parentMessageId: "old", description: "old", agent: "sisyphus", status: kind === "cancelled" ? "cancelled" : "completed", model: { providerID: "test", modelID: "original" } })
      const client = { session: { get: async () => kind === "api-error" ? { error: "unavailable" } : { data: { id, parentID: kind === "wrong-sdk-parent" ? "foreign" : "parent" } }, status: async () => kind === "status-api-error" ? { error: "unavailable" } : { data: { [id]: { type: kind === "busy" ? "busy" : "idle" } } }, messages: async () => ({ data: [] }), promptAsync } }
      const result = await executeBackgroundContinuation({ task_id: id, prompt: "continue", description: "recover", run_in_background: true, load_skills: [] }, { sessionID: "parent", metadata: async () => {} }, { client, manager: { resume: async () => { throw new Error(`Task not found for session: ${id}`) } } }, { sessionID: "parent", messageID: "now" })
      expect(result).not.toContain("Synchronous recovery")
      expect(result).toContain(expected)
    }
    expect(promptAsync).not.toHaveBeenCalled()
    clearBackgroundTaskRegistryForTesting()
  })

  test("retained recovery refuses a suggested replacement model and releases its claim", async () => {
    const { archiveBackgroundTask, clearBackgroundTaskRegistryForTesting, claimRetainedSessionRecovery } = require("../../features/background-agent/task-registry")
    clearBackgroundTaskRegistryForTesting()
    const id = "ses_model_recovery"
    archiveBackgroundTask({ id: "bg_model", sessionId: id, parentSessionId: "parent", parentMessageId: "old", description: "old", agent: "sisyphus", status: "completed", model: { providerID: "test", modelID: "original" } })
    const missingModel = Object.assign(new Error("original model unavailable"), { name: "ProviderModelNotFoundError", data: { providerID: "test", modelID: "original", suggestions: ["replacement"] } })
    const promptAsync = mock(async () => { throw missingModel })
    const client = { session: { get: async () => ({ data: { id, parentID: "parent" } }), status: async () => ({ data: {} }), messages: async () => ({ data: [] }), promptAsync } }
    const { executeBackgroundContinuation } = require("./background-continuation")
    const result = await executeBackgroundContinuation({ task_id: id, prompt: "continue", description: "recover", run_in_background: true, load_skills: [] }, { sessionID: "parent", metadata: async () => {} }, { client, manager: { resume: async () => { throw new Error(`Task not found for session: ${id}`) } } }, { sessionID: "parent", messageID: "now" })
    expect(result).toContain("Failed to send continuation prompt")
    expect(result).toContain("original model unavailable")
    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(promptAsync.mock.calls[0][0].body.model).toEqual({ providerID: "test", modelID: "original" })
    const claim = claimRetainedSessionRecovery(id, "parent")
    claim.release()
    clearBackgroundTaskRegistryForTesting()
  })

  test("reports an error instead of false success when the task is already running", async () => {
    //#given - manager rejects a continuation that cannot be delivered
    const mockManager = {
      resume: async () => {
        throw new Error(
          "Task bg_running is currently running and cannot accept a continuation prompt. " +
          "Wait for it to complete before resuming it with task_id.",
        )
      },
    }

    const mockCtx = {
      sessionID: "parent-session",
      callID: "call-running",
      metadata: mock(() => Promise.resolve()),
    }

    const args = {
      task_id: "ses_running_123",
      prompt: "apply updated instructions",
      description: "update running task",
      load_skills: [],
      run_in_background: true,
    }

    //#when
    const { executeBackgroundContinuation } = require("./background-continuation")
    const result = await executeBackgroundContinuation(
      args,
      mockCtx,
      { manager: mockManager },
      {
        sessionID: "parent-session",
        messageID: "msg-parent",
        agent: "sisyphus",
      },
    )

    //#then - the tool cannot claim a continuation that was never delivered
    expect(result).toContain("currently running and cannot accept a continuation prompt")
  })

  test("includes subagent in task_metadata when task has agent", async () => {
    //#given - mock manager.resume returning task with agent info
    const mockManager = {
      resume: async () => ({
        id: "bg_task_001",
        description: "oracle consultation",
        agent: "oracle",
        status: "running",
        sessionId: "ses_resumed_123",
      }),
    }

    const mockCtx = {
      sessionID: "parent-session",
      callID: "call-456",
      metadata: mock(() => Promise.resolve()),
    }

    const mockExecutorCtx = {
      manager: mockManager,
    }

    const parentContext = {
      sessionID: "parent-session",
      messageID: "msg-parent",
      agent: "sisyphus",
    }

    const args = {
      task_id: "ses_resumed_123",
      prompt: "continue working",
      description: "resume oracle",
      load_skills: [],
      run_in_background: true,
    }

    //#when - executeBackgroundContinuation completes
    const { executeBackgroundContinuation } = require("./background-continuation")
    const result = await executeBackgroundContinuation(args, mockCtx, mockExecutorCtx, parentContext)

    //#then - task_metadata should contain subagent field
    expect(result).toContain("<task_metadata>")
    expect(result).toContain("subagent: oracle")
    expect(result).toContain("session_id: ses_resumed_123")
    expect(result).toContain("background_task_id: bg_task_001")
    expect(result).not.toContain("task_id: ses_resumed_123")
    expect(result).toContain("Background Task ID: bg_task_001")
  })

  test("omits subagent from task_metadata when task agent is undefined", async () => {
    //#given - mock manager.resume returning task without agent
    const mockManager = {
      resume: async () => ({
        id: "bg_task_002",
        description: "unknown task",
        agent: undefined,
        status: "running",
        sessionId: "ses_resumed_456",
      }),
    }

    const mockCtx = {
      sessionID: "parent-session",
      callID: "call-789",
      metadata: mock(() => Promise.resolve()),
    }

    const mockExecutorCtx = {
      manager: mockManager,
    }

    const parentContext = {
      sessionID: "parent-session",
      messageID: "msg-parent",
      agent: "sisyphus",
    }

    const args = {
      task_id: "ses_resumed_456",
      prompt: "continue",
      description: "resume task",
      load_skills: [],
      run_in_background: true,
    }

    //#when - executeBackgroundContinuation completes without agent
    const { executeBackgroundContinuation } = require("./background-continuation")
    const result = await executeBackgroundContinuation(args, mockCtx, mockExecutorCtx, parentContext)

    //#then - task_metadata should NOT contain subagent field
    expect(result).toContain("<task_metadata>")
    expect(result).toContain("session_id: ses_resumed_456")
    expect(result).not.toContain("subagent:")
  })
  test("does not advertise background_output CTA in continuation return (issue #5221)", async () => {
    //#given - mock manager.resume
    const mockManager = {
      resume: async () => ({
        id: "bg_task_cta",
        description: "continue task",
        agent: "oracle",
        status: "running",
        sessionId: "ses_resumed_cta",
      }),
    }

    const mockCtx = {
      sessionID: "parent-session",
      callID: "call-cta",
      metadata: mock(() => Promise.resolve()),
    }

    const mockExecutorCtx = {
      manager: mockManager,
    }

    const parentContext = {
      sessionID: "parent-session",
      messageID: "msg-parent",
      agent: "sisyphus",
    }

    const args = {
      task_id: "ses_resumed_cta",
      prompt: "continue",
      description: "resume task",
      load_skills: [],
      run_in_background: true,
    }

    //#when
    const { executeBackgroundContinuation } = require("./background-continuation")
    const result = await executeBackgroundContinuation(args, mockCtx, mockExecutorCtx, parentContext)

    //#then - no polling CTA, anti-polling instruction preserved
    expect(result).not.toContain("Use `background_output` with task_id=")
    expect(result).not.toContain("to check.")
    expect(result).toContain("Do NOT call background_output now")
    expect(result).toContain("<system-reminder>")
  })

  test("keeps continuation system content out of the visible prompt", async () => {
    //#given
    let capturedPrompt: string | null = null
    let capturedSystem: string | null = null
    const mockManager = {
      resume: async (opts: { prompt: string; system?: string }) => {
        capturedPrompt = opts.prompt
        capturedSystem = opts.system ?? null
        return {
          id: "bg_task_leak",
          description: "prompt leak test",
          agent: "oracle",
          status: "running",
          sessionId: "ses_resumed_leak",
        }
      },
    }

    const mockCtx = {
      sessionID: "parent-session",
      callID: "call-leak",
      metadata: mock(() => Promise.resolve()),
    }

    const mockExecutorCtx = {
      manager: mockManager,
    }

    const parentContext = {
      sessionID: "parent-session",
      messageID: "msg-parent",
      agent: "sisyphus",
    }

    const systemContent = "<available_skills>\nskill1\nskill2\n</available_skills>"
    const followUpPrompt = "continue working on the task"

    const args = {
      task_id: "ses_resumed_leak",
      prompt: followUpPrompt,
      description: "prompt leak regression",
      load_skills: [],
      run_in_background: true,
    }

    //#when
    const { executeBackgroundContinuation } = require("./background-continuation")
    await executeBackgroundContinuation(args, mockCtx, mockExecutorCtx, parentContext, systemContent)

    //#then
    expect(capturedPrompt).toBe(followUpPrompt)
    expect(capturedSystem).toBe(systemContent)
  })
})
