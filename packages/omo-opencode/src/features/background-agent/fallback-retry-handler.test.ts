/// <reference types="bun-types" />

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { tryFallbackRetry, TeamModeFallbackError, type FallbackRetryHandlerDeps } from "./fallback-retry-handler"
import type { FallbackEntry } from "../../shared/model-requirements"
import type { ProviderModelsCache } from "../../shared/connected-providers-cache"
import { QUESTION_DENIED_SESSION_PERMISSION } from "../../shared/question-denied-session-permission"
import { transformModelForProvider as realTransformModelForProvider } from "@oh-my-opencode/model-core"
import { shouldRetryError as realShouldRetryError } from "../../shared/model-error-classifier"

const sharedLogMock = mock(() => {})
const readConnectedProvidersCacheMock = mock(() => null)
const readProviderModelsCacheMock = mock((): ProviderModelsCache | null => null)
const shouldRetryErrorMock = mock(() => true)
const getNextFallbackMock = mock((chain: FallbackEntry[], attempt: number) => chain[attempt])
const hasMoreFallbacksMock = mock((chain: FallbackEntry[], attempt: number) => attempt < chain.length)
const selectFallbackProviderMock = mock((providers: string[]) => providers[0])
const transformModelForProviderMock = mock((_provider: string, model: string) => model)

import type { BackgroundTask } from "./types"
import type { ConcurrencyManager } from "./concurrency"
import type { OpencodeClient, QueueItem } from "./constants"

const retryHandlerDeps: Partial<FallbackRetryHandlerDeps> = {
  log: sharedLogMock,
  readConnectedProvidersCache: readConnectedProvidersCacheMock,
  readProviderModelsCache: readProviderModelsCacheMock,
  shouldRetryError: shouldRetryErrorMock,
  getNextFallback: getNextFallbackMock,
  hasMoreFallbacks: hasMoreFallbacksMock,
  selectFallbackProvider: selectFallbackProviderMock,
  transformModelForProvider: transformModelForProviderMock,
}

function createDeferredPromise(): {
  promise: Promise<void>
  resolve: () => void
} {
  let resolvePromise = () => {}
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve: resolvePromise,
  }
}

function createMockTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "test-task-1",
    description: "test task",
    prompt: "test prompt",
    agent: "sisyphus-junior",
    status: "error",
    parentSessionId: "parent-session-1",
    parentMessageId: "parent-message-1",
    fallbackChain: [
      { model: "fallback-model-1", providers: ["provider-a"], variant: undefined },
      { model: "fallback-model-2", providers: ["provider-b"], variant: undefined },
    ],
    attemptCount: 0,
    concurrencyKey: "provider-a/original-model",
    model: { providerID: "provider-a", modelID: "original-model" },
    ...overrides,
  }
}

function createMockConcurrencyManager(): ConcurrencyManager {
  return {
    release: mock(() => {}),
    acquire: mock(async () => {}),
    getQueueLength: mock(() => 0),
    getActiveCount: mock(() => 0),
  } as never
}

function createMockClient(): {
  client: OpencodeClient
  abortMock: ReturnType<typeof mock>
  updateMock: ReturnType<typeof mock>
} {
  const abortMock = mock(async () => ({}))
  const updateMock = mock(async () => ({}))
  return {
    client: {
      session: {
        abort: abortMock,
        update: updateMock,
      },
    } as never,
    abortMock,
    updateMock,
  }
}

function createDefaultArgs(taskOverrides: Partial<BackgroundTask> = {}) {
  const processKeyFn = mock(() => {})
  const queuesByKey = new Map<string, QueueItem[]>()
  const idleDeferralTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const concurrencyManager = createMockConcurrencyManager()
  const { client, abortMock, updateMock } = createMockClient()
  const task = createMockTask(taskOverrides)

  return {
    task,
    errorInfo: { name: "OverloadedError", message: "model overloaded" },
    source: "polling",
    concurrencyManager,
    client,
    abortMock,
    updateMock,
    idleDeferralTimers,
    queuesByKey,
    processKey: processKeyFn,
    deps: retryHandlerDeps,
  }
}

function modelKeyForTask(task: BackgroundTask): string {
  const model = task.model
  if (!model) throw new Error("expected task model")
  return `${model.providerID}/${model.modelID}`
}

describe("tryFallbackRetry", () => {
  afterAll(() => {
    mock.restore()
  })

  beforeEach(() => {
    shouldRetryErrorMock.mockImplementation(() => true)
    selectFallbackProviderMock.mockImplementation((providers: string[]) => providers[0])
    readProviderModelsCacheMock.mockReturnValue(null)
    readConnectedProvidersCacheMock.mockReturnValue(null)
    getNextFallbackMock.mockImplementation((chain: FallbackEntry[], attempt: number) => chain[attempt])
    hasMoreFallbacksMock.mockImplementation((chain: FallbackEntry[], attempt: number) => attempt < chain.length)
    transformModelForProviderMock.mockImplementation((_provider: string, model: string) => model)
  })

  describe("#given retryable error with fallback chain", () => {
    test("preserves native Anthropic IDs when retrying from GitHub Copilot fallback aliases", async () => {
      transformModelForProviderMock.mockImplementation(realTransformModelForProvider)
      const args = createDefaultArgs({
        sessionId: "old-session",
        model: { providerID: "github-copilot", modelID: "claude-haiku-4.5" },
        fallbackChain: [{ model: "claude-haiku-4.5", providers: ["anthropic"], variant: undefined }],
      })

      const result = await tryFallbackRetry(args)

      expect(result).toBe(true)
      expect(args.task.retryNotification?.nextModel).toBe("anthropic/claude-haiku-4-5")

      const queue = args.queuesByKey.get("anthropic/claude-haiku-4-5")
      expect(queue).toBeDefined()
      expect(queue?.[0]?.input.model).toEqual({
        providerID: "anthropic",
        modelID: "claude-haiku-4-5",
        variant: undefined,
      })
      expect(args.updateMock).toHaveBeenCalledWith({
        path: { id: "old-session" },
        body: { title: "test task retrying on anthropic/claude-haiku-4-5" },
      })
    })

    test("returns true and enqueues retry", async () => {
      const args = createDefaultArgs()

      const result = await tryFallbackRetry(args)

      expect(result).toBe(true)
    })

    test("retries sanitized provider authorization failures on the next fallback model", async () => {
      const args = createDefaultArgs({
        sessionId: "old-session",
        model: { providerID: "anthropic", modelID: "claude-opus-4-8", variant: "max" },
        fallbackChain: [
          { model: "claude-opus-4-8", providers: ["anthropic"], variant: "max" },
          { model: "gpt-5.5", providers: ["openai"], variant: "xhigh" },
        ],
      })

      const result = await tryFallbackRetry({
        ...args,
        errorInfo: { message: "Authentication or provider authorization failed." },
        deps: {
          ...retryHandlerDeps,
          shouldRetryError: realShouldRetryError,
        },
      })

      expect(result).toBe(true)
      expect(args.task.attemptCount).toBe(2)
      expect(args.task.model).toEqual({
        providerID: "openai",
        modelID: "gpt-5.5",
        variant: "xhigh",
      })
      expect(args.processKey).toHaveBeenCalledWith("openai/gpt-5.5")
      expect(args.queuesByKey.get("openai/gpt-5.5")?.[0]?.input.model).toEqual({
        providerID: "openai",
        modelID: "gpt-5.5",
        variant: "xhigh",
      })
    })

    test("uses same-session retry hook without aborting or enqueueing a new launch", async () => {
      const sameSessionRetry = mock(async () => true)
      const onSessionCreated = mock(async () => {})
      const args = createDefaultArgs({
        sessionId: "old-session",
        status: "running",
        onSessionCreated,
        currentAttemptID: "att_current",
        attempts: [
          {
            attemptId: "att_current",
            attemptNumber: 1,
            sessionId: "old-session",
            providerId: "provider-a",
            modelId: "original-model",
            status: "running",
          },
        ],
      })

      const result = await tryFallbackRetry({
        ...args,
        onSameSessionRetry: sameSessionRetry,
      })

      expect(result).toBe(true)
      expect(sameSessionRetry).toHaveBeenCalledWith(expect.objectContaining({
        sessionID: "old-session",
        nextModel: {
          providerID: "provider-a",
          modelID: "fallback-model-1",
          variant: undefined,
        },
      }))
      expect(args.abortMock).not.toHaveBeenCalled()
      expect(args.processKey).not.toHaveBeenCalled()
      expect(args.queuesByKey.size).toBe(0)
      expect(args.task.sessionId).toBe("old-session")
      expect(args.task.status).toBe("running")
      expect(args.task.model).toEqual({
        providerID: "provider-a",
        modelID: "fallback-model-1",
        variant: undefined,
      })
      expect(onSessionCreated).toHaveBeenCalledWith("old-session", {
        providerID: "provider-a",
        modelID: "fallback-model-1",
        variant: undefined,
      })
      expect(args.task.attempts).toHaveLength(1)
      expect(args.task.attempts?.[0]).toMatchObject({
        attemptId: "att_current",
        sessionId: "old-session",
        providerId: "provider-a",
        modelId: "fallback-model-1",
        status: "running",
      })
    })

    test("does not fall back to new session retry when same-session retry fails", async () => {
      const sameSessionRetry = mock(async () => false)
      const args = createDefaultArgs({
        sessionId: "old-session",
        status: "running",
        currentAttemptID: "att_current",
        attempts: [
          {
            attemptId: "att_current",
            attemptNumber: 1,
            sessionId: "old-session",
            providerId: "provider-a",
            modelId: "original-model",
            status: "running",
          },
        ],
      })

      const result = await tryFallbackRetry({
        ...args,
        onSameSessionRetry: sameSessionRetry,
      })

      expect(result).toBe(false)
      expect(sameSessionRetry).toHaveBeenCalled()
      expect(args.abortMock).not.toHaveBeenCalled()
      expect(args.processKey).not.toHaveBeenCalled()
      expect(args.queuesByKey.size).toBe(0)
      expect(args.task.sessionId).toBe("old-session")
      expect(args.task.status).toBe("running")
      expect(args.task.model).toEqual({ providerID: "provider-a", modelID: "original-model" })
    })

    test("fails closed when same-session fallback session callback rejects", async () => {
      // given
      const sameSessionRetry = mock(async () => true)
      const onSessionCreated = mock(async () => {
        throw new Error("team registration failed")
      })
      const args = createDefaultArgs({
        sessionId: "old-session",
        status: "running",
        onSessionCreated,
        currentAttemptID: "att_current",
        attempts: [
          {
            attemptId: "att_current",
            attemptNumber: 1,
            sessionId: "old-session",
            providerId: "provider-a",
            modelId: "original-model",
            status: "running",
          },
        ],
      })

      // when
      const result = await tryFallbackRetry({
        ...args,
        onSameSessionRetry: sameSessionRetry,
      })

      // then
      expect(result).toBe(false)
      expect(sameSessionRetry).not.toHaveBeenCalled()
      expect(onSessionCreated).toHaveBeenCalledWith("old-session", {
        providerID: "provider-a",
        modelID: "fallback-model-1",
        variant: undefined,
      })
      expect(args.abortMock).not.toHaveBeenCalled()
      expect(args.processKey).not.toHaveBeenCalled()
      expect(args.task.model).toEqual({ providerID: "provider-a", modelID: "original-model" })
    })

    test("does not repeatedly dispatch the same failed no-output fallback prompt", async () => {
      // given
      const sameSessionRetry = mock(async () => false)
      const args = createDefaultArgs({
        sessionId: "old-session",
        status: "running",
        currentAttemptID: "att_current",
        attempts: [
          {
            attemptId: "att_current",
            attemptNumber: 1,
            sessionId: "old-session",
            providerId: "provider-a",
            modelId: "original-model",
            status: "running",
          },
        ],
      })

      // when
      const firstResult = await tryFallbackRetry({
        ...args,
        source: "session.idle no-output",
        onSameSessionRetry: sameSessionRetry,
      })
      const secondResult = await tryFallbackRetry({
        ...args,
        source: "polling:session.idle no-output",
        onSameSessionRetry: sameSessionRetry,
      })

      // then
      expect(firstResult).toBe(false)
      expect(secondResult).toBe(false)
      expect(sameSessionRetry).toHaveBeenCalledTimes(1)
      expect(args.abortMock).not.toHaveBeenCalled()
      expect(args.processKey).not.toHaveBeenCalled()
    })

    test("resets task status to pending", async () => {
      const args = createDefaultArgs()

      await tryFallbackRetry(args)

      expect(args.task.status).toBe("pending")
    })

    test("increments attemptCount", async () => {
      const args = createDefaultArgs()

      await tryFallbackRetry(args)

      expect(args.task.attemptCount).toBe(1)
    })

    test("updates task model to fallback", async () => {
      const args = createDefaultArgs()

      await tryFallbackRetry(args)

      expect(args.task.model?.modelID).toBe("fallback-model-1")
      expect(args.task.model?.providerID).toBe("provider-a")
    })

    test("clears sessionID and startedAt", async () => {
      const args = createDefaultArgs({
        sessionId: "old-session",
        startedAt: new Date(),
      })

      await tryFallbackRetry(args)

      expect(args.task.sessionId).toBeUndefined()
      expect(args.task.startedAt).toBeUndefined()
    })

    test("clears error field", async () => {
      const args = createDefaultArgs({ error: "previous error" })

      await tryFallbackRetry(args)

      expect(args.task.error).toBeUndefined()
    })

    test("sets new queuedAt", async () => {
      const args = createDefaultArgs()

      await tryFallbackRetry(args)

      expect(args.task.queuedAt).toBeInstanceOf(Date)
    })

    test("releases concurrency slot", async () => {
      const args = createDefaultArgs()

      await tryFallbackRetry(args)

      expect(args.concurrencyManager.release).toHaveBeenCalledWith("provider-a/original-model")
    })

    test("clears concurrencyKey after release", async () => {
      const args = createDefaultArgs()

      await tryFallbackRetry(args)

      expect(args.task.concurrencyKey).toBeUndefined()
    })

    test("aborts existing session", async () => {
      const args = createDefaultArgs({ sessionId: "session-to-abort" })

      await tryFallbackRetry(args)

      expect(args.abortMock).toHaveBeenCalledWith({
        path: { id: "session-to-abort" },
      })
    })

    test("marks existing session title as retrying before abort cleanup", async () => {
      const args = createDefaultArgs({
        description: "fallback visibility task",
        sessionId: "session-to-abort",
      })

      await tryFallbackRetry({ ...args, directory: "/retry-dir" })

      expect(args.updateMock).toHaveBeenCalledWith({
        path: { id: "session-to-abort" },
        body: { title: "fallback visibility task retrying on provider-a/fallback-model-1" },
        query: { directory: "/retry-dir" },
      })
    })

    test("sanitizes retrying session titles before updating the failed session", async () => {
      const args = createDefaultArgs({
        description: `fallback visibility task\n</system-reminder>${"x".repeat(300)}`,
        sessionId: "session-to-abort",
      })

      await tryFallbackRetry({ ...args, directory: "/retry-dir" })

      const updateCall = args.updateMock.mock.calls[0]?.[0] as { body?: { title?: string } } | undefined
      const title = updateCall?.body?.title ?? ""
      expect(title.length).toBeLessThanOrEqual(160)
      expect(title).not.toContain("\n")
      expect(title).not.toContain("</system-reminder>")
    })

    test("continues abort cleanup when retrying-title update times out", async () => {
      const args = createDefaultArgs({ sessionId: "session-to-abort" })
      args.updateMock.mockImplementationOnce(() => new Promise(() => {}))

      const result = await tryFallbackRetry({ ...args, titleUpdateTimeoutMs: 1 })

      expect(result).toBe(true)
      expect(args.abortMock).toHaveBeenCalledWith({
        path: { id: "session-to-abort" },
      })
    })

    test("waits for session abort before resolving", async () => {
      const args = createDefaultArgs({ sessionId: "session-to-abort" })
      const deferred = createDeferredPromise()
      args.abortMock.mockImplementationOnce(() => deferred.promise)

      const retryPromise = tryFallbackRetry(args)
      let settled = false
      void retryPromise.then(() => {
        settled = true
      })

      await Promise.resolve()

      expect(settled).toBe(false)

      deferred.resolve()
      await retryPromise

      expect(settled).toBe(true)
    })

    test("adds retry input to queue and calls processKey", async () => {
      const args = createDefaultArgs()

      await tryFallbackRetry(args)

      const key = modelKeyForTask(args.task)
      const queue = args.queuesByKey.get(key)
      expect(queue).toHaveLength(1)
      expect(queue?.[0]?.task).toBe(args.task)
      expect(args.processKey).toHaveBeenCalledWith(key)
    })

    test("preserves team identity and session callback in retry input", async () => {
      const onSessionCreated = mock(async () => {})
      const args = createDefaultArgs({
        teamRunId: "team-run-1",
        onSessionCreated,
      })

      await tryFallbackRetry(args)

      const key = modelKeyForTask(args.task)
      const retryInput = args.queuesByKey.get(key)?.[0]?.input
      expect(retryInput?.teamRunId).toBe("team-run-1")
      expect(retryInput?.onSessionCreated).toBe(onSessionCreated)
    })

    test("preserves delegated launch context in retry input", async () => {
      // given
      const args = createDefaultArgs({
        skillContent: "delegated skill system",
        sessionPermission: QUESTION_DENIED_SESSION_PERMISSION,
        userPermission: Object.freeze({
          bash: "deny",
          edit: "deny",
          read: "allow",
        }),
      })

      // when
      await tryFallbackRetry(args)

      // then
      const key = modelKeyForTask(args.task)
      const retryInput = args.queuesByKey.get(key)?.[0]?.input
      expect(retryInput?.skillContent).toBe("delegated skill system")
      expect(retryInput?.sessionPermission).toEqual(QUESTION_DENIED_SESSION_PERMISSION)
      expect(retryInput?.userPermission).toEqual({
        bash: "deny",
        edit: "deny",
        read: "allow",
      })
    })

    test("finalizes the failed attempt, creates a new pending attempt, and enqueues its explicit attemptID", async () => {
      const args = createDefaultArgs({
        status: "running",
        sessionId: "session-attempt-1",
        startedAt: new Date("2026-04-27T00:00:00.000Z"),
        attempts: [
          {
            attemptId: "attempt-1",
            attemptNumber: 1,
            sessionId: "session-attempt-1",
            providerId: "provider-a",
            modelId: "original-model",
            status: "running",
            startedAt: new Date("2026-04-27T00:00:00.000Z"),
          },
        ],
        currentAttemptID: "attempt-1",
      })

      await tryFallbackRetry(args)

      expect(args.task.attempts).toHaveLength(2)
      expect(args.task.attempts?.[0]).toMatchObject({
        attemptId: "attempt-1",
        sessionId: "session-attempt-1",
        status: "error",
        error: "model overloaded",
      })
      expect(args.task.attempts?.[0]?.completedAt).toBeInstanceOf(Date)

      const nextAttempt = args.task.attempts?.[1]
      expect(nextAttempt).toBeDefined()
      expect(nextAttempt?.attemptNumber).toBe(2)
      expect(nextAttempt?.providerId).toBe("provider-a")
      expect(nextAttempt?.modelId).toBe("fallback-model-1")
      expect(nextAttempt?.status).toBe("pending")

      expect(args.task.currentAttemptID).toBe(nextAttempt?.attemptId)
      expect(args.task.status).toBe("pending")
      expect(args.task.model).toEqual({
        providerID: "provider-a",
        modelID: "fallback-model-1",
        variant: undefined,
      })

      const key = modelKeyForTask(args.task)
      const queue = args.queuesByKey.get(key)
      expect(queue).toBeDefined()
      const queuedAttemptID = queue?.[0]?.attemptID
      expect(queuedAttemptID).toBeDefined()
      expect(nextAttempt?.attemptId).toBeDefined()
      expect(queuedAttemptID).toBe(nextAttempt?.attemptId ?? "")
    })
  })

  describe("#given non-retryable error", () => {
    test("returns false when shouldRetryError returns false", async () => {
      shouldRetryErrorMock.mockImplementation(() => false)
      const args = createDefaultArgs()

      const result = await tryFallbackRetry(args)

      expect(result).toBe(false)
    })
  })

  describe("#given no fallback chain", () => {
    test("returns false when fallbackChain is undefined", async () => {
      const args = createDefaultArgs({ fallbackChain: undefined })

      const result = await tryFallbackRetry(args)

      expect(result).toBe(false)
    })

    test("returns false when fallbackChain is empty", async () => {
      const args = createDefaultArgs({ fallbackChain: [] })

      const result = await tryFallbackRetry(args)

      expect(result).toBe(false)
    })
  })

  describe("#given exhausted fallbacks", () => {
    test("returns false when attemptCount exceeds chain length", async () => {
      const args = createDefaultArgs({ attemptCount: 5 })

      const result = await tryFallbackRetry(args)

      expect(result).toBe(false)
    })
  })

  describe("#given task without concurrency key", () => {
    test("skips concurrency release", async () => {
      const args = createDefaultArgs({ concurrencyKey: undefined })

      await tryFallbackRetry(args)

      expect(args.concurrencyManager.release).not.toHaveBeenCalled()
    })
  })

  describe("#given task without session", () => {
    test("skips session abort", async () => {
      const args = createDefaultArgs({ sessionId: undefined })

      await tryFallbackRetry(args)

      expect(args.abortMock).not.toHaveBeenCalled()
    })

    test("deduplicates concurrent retry attempts before no-session retry mutates task", async () => {
      const args = createDefaultArgs({
        sessionId: undefined,
        fallbackChain: [
          { model: "fallback-model-1", providers: ["provider-a"], variant: undefined },
          { model: "fallback-model-2", providers: ["provider-b"], variant: undefined },
        ],
      })

      const firstRetry = tryFallbackRetry(args)
      const secondRetry = tryFallbackRetry(args)
      const results = await Promise.all([firstRetry, secondRetry])

      expect(results).toEqual([true, true])
      expect(args.abortMock).not.toHaveBeenCalled()
      expect(args.processKey).toHaveBeenCalledTimes(1)
      const retryQueue = args.queuesByKey.get("provider-a/fallback-model-1")
      expect(retryQueue).toHaveLength(1)
      expect(args.queuesByKey.get("provider-b/fallback-model-2")).toBeUndefined()
      expect(args.task.attempts).toHaveLength(2)
      expect(args.task.attemptCount).toBe(1)
      expect(args.task.model).toEqual({
        providerID: "provider-a",
        modelID: "fallback-model-1",
        variant: undefined,
      })
    })
  })

  describe("#given active session abort fails", () => {
    test("returns false without queueing or mutating task retry state", async () => {
      const startedAt = new Date("2026-05-31T00:00:00.000Z")
      const args = createDefaultArgs({
        sessionId: "old-session",
        status: "running",
        startedAt,
      })
      args.abortMock.mockImplementation(async () => ({ error: "abort refused" }))

      const result = await tryFallbackRetry(args)

      expect(result).toBe(false)
      expect(args.abortMock).toHaveBeenCalledWith({ path: { id: "old-session" } })
      expect(args.processKey).not.toHaveBeenCalled()
      expect(args.queuesByKey.size).toBe(0)
      expect(args.concurrencyManager.release).not.toHaveBeenCalled()
      expect(args.updateMock).not.toHaveBeenCalled()
      expect(args.task.status).toBe("running")
      expect(args.task.sessionId).toBe("old-session")
      expect(args.task.startedAt).toBe(startedAt)
      expect(args.task.attemptCount).toBe(0)
      expect(args.task.model).toEqual({ providerID: "provider-a", modelID: "original-model" })
      expect(args.task.retryNotification).toBeUndefined()
      expect(args.task.currentAttemptID).toBeUndefined()
    })

    test("deduplicates concurrent retry attempts while abort is pending", async () => {
      const abortGate = createDeferredPromise()
      const args = createDefaultArgs({
        sessionId: "old-session",
        status: "running",
      })
      args.abortMock.mockImplementation(async () => {
        await abortGate.promise
        return {}
      })

      const firstRetry = tryFallbackRetry(args)
      const secondRetry = tryFallbackRetry(args)

      await Promise.resolve()

      expect(args.abortMock).toHaveBeenCalledTimes(1)
      expect(args.processKey).not.toHaveBeenCalled()
      expect(args.queuesByKey.size).toBe(0)

      abortGate.resolve()
      const results = await Promise.all([firstRetry, secondRetry])

      expect(results).toEqual([true, true])
      expect(args.abortMock).toHaveBeenCalledTimes(1)
      expect(args.processKey).toHaveBeenCalledTimes(1)
      expect(args.concurrencyManager.release).toHaveBeenCalledTimes(1)
      const retryQueue = args.queuesByKey.get("provider-a/fallback-model-1")
      expect(retryQueue).toHaveLength(1)
      expect(args.task.attempts).toHaveLength(2)
      expect(args.task.attemptCount).toBe(1)
    })
  })

  describe("#given active idle deferral timer", () => {
    test("clears the timer and removes from map", async () => {
      const args = createDefaultArgs()
      const timerId = setTimeout(() => {}, 10000)
      args.idleDeferralTimers.set("test-task-1", timerId)

      await tryFallbackRetry(args)

      expect(args.idleDeferralTimers.has("test-task-1")).toBe(false)
    })
  })

  describe("#given second attempt", () => {
    test("uses second fallback in chain", async () => {
      const args = createDefaultArgs({ attemptCount: 1 })

      await tryFallbackRetry(args)

      expect(args.task.model?.modelID).toBe("fallback-model-2")
      expect(args.task.attemptCount).toBe(2)
    })
  })

  describe("#given first fallback is a no-op for the current model", () => {
    test("skips the no-op fallback and advances to the next distinct model", async () => {
      const args = createDefaultArgs({
        model: { providerID: "provider-a", modelID: "fallback-model-1" },
        fallbackChain: [
          { model: "fallback-model-1", providers: ["provider-a"], variant: undefined },
          { model: "fallback-model-2", providers: ["provider-b"], variant: undefined },
        ],
      })

      const result = await tryFallbackRetry(args)

      expect(result).toBe(true)
      expect(args.task.model?.providerID).toBe("provider-b")
      expect(args.task.model?.modelID).toBe("fallback-model-2")
      expect(args.task.attemptCount).toBe(2)
    })
  })

  describe("#given disconnected fallback providers with connected preferred provider", () => {
    test("skips explicit-provider fallback entries when none of their providers are connected", async () => {
      readProviderModelsCacheMock.mockReturnValueOnce({
        connected: ["provider-a"],
        models: {},
        updatedAt: new Date("2026-05-16T00:00:00.000Z").toISOString(),
      })

      const args = createDefaultArgs({
        fallbackChain: [{ model: "fallback-model-1", providers: ["provider-b"], variant: undefined }],
        model: { providerID: "provider-a", modelID: "original-model" },
      })

      const providerCallsBefore = selectFallbackProviderMock.mock.calls.length

      const result = await tryFallbackRetry(args)

      expect(result).toBe(false)
      expect(args.task.model?.providerID).toBe("provider-a")
      expect(args.task.model?.modelID).toBe("original-model")
      expect(selectFallbackProviderMock.mock.calls.length).toBe(providerCallsBefore)
    })
  })

  describe("#team-mode fallback", () => {
    test("throws TeamModeFallbackError when teamRunId is set but onSessionCreated is absent", async () => {
      // given: a team-mode task that somehow lost its onSessionCreated callback —
      // without it the fallback session would not be registered in the team-session
      // registry and every team tool call would silently fail with "not in team"
      const args = createDefaultArgs({
        teamRunId: "team-run-abc",
        onSessionCreated: undefined,
      })

      // when
      let firstError: unknown
      try {
        await tryFallbackRetry(args)
      } catch (error) {
        if (!(error instanceof Error)) throw error
        firstError = error
      }
      let secondError: unknown
      try {
        await tryFallbackRetry(createDefaultArgs({ teamRunId: "team-run-abc", onSessionCreated: undefined }))
      } catch (error) {
        if (!(error instanceof Error)) throw error
        secondError = error
      }

      // then: a bounded structured error must surface instead
      expect(firstError).toBeInstanceOf(TeamModeFallbackError)
      expect(secondError).toBeInstanceOf(Error)
      expect((secondError as Error).message).toContain("team-mode fallback denied: cannot preserve team context")
    })

    test("proceeds normally when teamRunId and onSessionCreated are both present", async () => {
      // given: a properly-formed team-mode task with its session registration callback
      const onSessionCreated = mock(async () => {})
      const args = createDefaultArgs({
        teamRunId: "team-run-abc",
        onSessionCreated,
      })

      // when
      const result = await tryFallbackRetry(args)

      // then: fallback is queued and the retry input preserves both team fields
      expect(result).toBe(true)
      const key = modelKeyForTask(args.task)
      const retryInput = args.queuesByKey.get(key)?.[0]?.input
      expect(retryInput?.teamRunId).toBe("team-run-abc")
      expect(retryInput?.onSessionCreated).toBe(onSessionCreated)
    })
  })
})
