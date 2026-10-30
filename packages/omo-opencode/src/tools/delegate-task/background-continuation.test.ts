/// <reference types="bun-types" />
const { describe, test, expect, mock } = require("bun:test")

function createRetainedRecoveryManager(client: unknown) {
  const { tmpdir } = require("node:os")
  const { BackgroundManager } = require("../../features/background-agent/manager")
  const manager = new BackgroundManager({ pluginContext: { client, directory: tmpdir() } })
  const notified: Array<{ id: string; status: string }> = []
  manager.notifyParentSession = async (task: { id: string; status: string }) => {
    notified.push({ id: task.id, status: task.status })
  }
  return { manager, notified }
}

describe("executeBackgroundContinuation - subagent metadata", () => {
  test("continues an archived retained session in the background under its original task ID and notifies on completion", async () => {
    const { archiveBackgroundTask, clearBackgroundTaskRegistryForTesting } = require("../../features/background-agent/task-registry")
    const { releaseAllPromptAsyncReservationsForTesting } = require("../../hooks/shared/prompt-async-gate")
    clearBackgroundTaskRegistryForTesting()
    const id = "ses_retained_recovery"
    // given: the manager forgot the finished task, but its SDK session and archive record remain
    archiveBackgroundTask({ id: "bg_retained", sessionId: id, parentSessionId: "parent-session", parentMessageId: "old", description: "retained", prompt: "old", agent: "sisyphus", status: "completed", model: { providerID: "test", modelID: "original", variant: "high", reasoningEffort: "high" } })
    const create = mock(() => { throw new Error("must not create") })
    const remove = mock(() => { throw new Error("must not delete") })
    const promptAsync = mock(async () => ({}))
    const client = { session: {
      get: async () => ({ data: { id, parentID: "parent-session" } }),
      status: async () => ({ data: {} }),
      messages: async () => ({ data: [] }),
      promptAsync, create, delete: remove, abort: async () => ({}),
    } }
    const { manager, notified } = createRetainedRecoveryManager(client)
    const metadata = mock(async () => {})
    const { executeBackgroundContinuation } = require("./background-continuation")
    try {
      // when: the parent continues it with run_in_background=true
      const result = await executeBackgroundContinuation({ task_id: id, prompt: "continue", description: "recover", run_in_background: true, load_skills: [] }, { sessionID: "parent-session", callID: "recovery-call", metadata, abort: new AbortController().signal }, { client, manager, syncPollTimeoutMs: 4000 }, { sessionID: "parent-session", messageID: "current" }, "authorized skills")

      // then: the call returns at once with the original background task ID and the child runs on its original agent/model
      expect(result).toContain("Background task continued.")
      expect(result).toContain("Background Task ID: bg_retained")
      expect(result).not.toContain("Synchronous recovery")
      expect(manager.getTask("bg_retained")?.status).toBe("running")
      expect(promptAsync).toHaveBeenCalledTimes(1)
      expect(promptAsync.mock.calls[0][0]).toMatchObject({ path: { id }, body: { agent: "sisyphus", model: { providerID: "test", modelID: "original" }, variant: "high", system: "authorized skills" } })
      expect(create).not.toHaveBeenCalled()
      expect(remove).not.toHaveBeenCalled()
      expect(metadata.mock.calls.at(-1)[0].metadata).toMatchObject({ run_in_background: true, sessionId: id, backgroundTaskId: "bg_retained" })

      // when: the resumed child finishes
      await manager.tryCompleteTask(manager.getTask("bg_retained"), "session.idle event")

      // then: the parent gets the normal completion notification for the same ID
      expect(notified).toEqual([{ id: "bg_retained", status: "completed" }])
    } finally {
      await manager.shutdown()
      releaseAllPromptAsyncReservationsForTesting()
      clearBackgroundTaskRegistryForTesting()
    }
  })

  test("continues a retained session after an OpenCode restart with the agent and model OpenCode recorded for it", async () => {
    const { clearBackgroundTaskRegistryForTesting } = require("../../features/background-agent/task-registry")
    const { releaseAllPromptAsyncReservationsForTesting } = require("../../hooks/shared/prompt-async-gate")
    clearBackgroundTaskRegistryForTesting()
    const id = "ses_restarted_recovery"
    // given: the archive is empty after a restart; the child session and its messages remain
    const promptAsync = mock(async () => ({}))
    const client = { session: {
      get: async () => ({ data: { id, parentID: "parent-session", title: "service-dev worker" } }),
      status: async () => ({ data: { [id]: { type: "idle" } } }),
      messages: async () => ({ data: [
        { info: { role: "user", agent: "pinion-rust-dev", model: { providerID: "anthropic", modelID: "claude-opus-5-5", variant: "high" } } },
        { info: { role: "assistant", agent: "pinion-rust-dev", time: { created: 1, completed: 2 }, error: { name: "APIError" } } },
      ] }),
      promptAsync, abort: async () => ({}),
    } }
    const { manager } = createRetainedRecoveryManager(client)
    const { executeBackgroundContinuation } = require("./background-continuation")
    try {
      // when
      const result = await executeBackgroundContinuation({ task_id: id, prompt: "continue", description: "recover", run_in_background: true, load_skills: [] }, { sessionID: "parent-session", metadata: async () => {} }, { client, manager }, { sessionID: "parent-session", messageID: "current" })

      // then: the child continues on its recorded agent, model and variant
      expect(result).toContain("Background task continued.")
      expect(result).toContain("Agent: pinion-rust-dev")
      expect(promptAsync).toHaveBeenCalledTimes(1)
      expect(promptAsync.mock.calls[0][0]).toMatchObject({ path: { id }, body: { agent: "pinion-rust-dev", model: { providerID: "anthropic", modelID: "claude-opus-5-5" }, variant: "high" } })
    } finally {
      await manager.shutdown()
      releaseAllPromptAsyncReservationsForTesting()
      clearBackgroundTaskRegistryForTesting()
    }
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

  test("retained background recovery keeps the original model when that model is unavailable", async () => {
    const { archiveBackgroundTask, clearBackgroundTaskRegistryForTesting } = require("../../features/background-agent/task-registry")
    const { releaseAllPromptAsyncReservationsForTesting } = require("../../hooks/shared/prompt-async-gate")
    clearBackgroundTaskRegistryForTesting()
    const id = "ses_model_recovery"
    archiveBackgroundTask({ id: "bg_model", sessionId: id, parentSessionId: "parent", parentMessageId: "old", description: "old", agent: "sisyphus", status: "completed", model: { providerID: "test", modelID: "original" } })
    const missingModel = Object.assign(new Error("original model unavailable"), { name: "ProviderModelNotFoundError", data: { providerID: "test", modelID: "original", suggestions: ["replacement"] } })
    const promptAsync = mock(async () => { throw missingModel })
    const client = { session: { get: async () => ({ data: { id, parentID: "parent" } }), status: async () => ({ data: {} }), messages: async () => ({ data: [] }), promptAsync, abort: async () => ({}) } }
    const { manager, notified } = createRetainedRecoveryManager(client)
    const { executeBackgroundContinuation } = require("./background-continuation")
    try {
      // when
      const result = await executeBackgroundContinuation({ task_id: id, prompt: "continue", description: "recover", run_in_background: true, load_skills: [] }, { sessionID: "parent", metadata: async () => {} }, { client, manager }, { sessionID: "parent", messageID: "now" })
      await new Promise((resolve) => setTimeout(resolve, 50))

      // then: the prompt failure ends the task with one terminal notification; no replacement model is tried
      expect(result).toContain("Background Task ID: bg_model")
      expect(promptAsync.mock.calls.length).toBeGreaterThanOrEqual(1)
      for (const call of promptAsync.mock.calls) expect(call[0].body.model).toEqual({ providerID: "test", modelID: "original" })
      expect(notified).toEqual([{ id: "bg_model", status: "interrupt" }])
    } finally {
      await manager.shutdown()
      releaseAllPromptAsyncReservationsForTesting()
      clearBackgroundTaskRegistryForTesting()
    }
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
