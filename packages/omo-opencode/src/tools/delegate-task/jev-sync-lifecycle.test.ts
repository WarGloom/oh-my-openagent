import { expect, spyOn, test } from "bun:test"
import { beginJevDecision } from "./jev-routing-context"
import { isDeepHighEscalation } from "./openai-categories"
import { executeSyncTask } from "./sync-task"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import {
  findRegisteredBackgroundTaskBySession,
  getRegisteredBackgroundTask,
  clearBackgroundTaskRegistryForTesting,
} from "../../features/background-agent/task-registry"
import { resumeSyncLifecycleTask } from "./sync-task-lifecycle"
import * as ledger from "./jev-routing-ledger"
import { executeSyncContinuation } from "./sync-continuation"
import { BackgroundManager } from "../../features/background-agent/manager"
import type { BackgroundTask } from "../../features/background-agent/types"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test.each([
  ["ESCALATE: deep-high\nDecision remains open", true],
  ["ESCALATE: deep-high\r\nDecision remains open", true],
  ["Report\nESCALATE: deep-high", false],
  ["ESCALATE: deep-high-extra", false],
  [" ESCALATE: deep-high", false],
])("escalation parser classifies the first line of %s", (output, expected) => {
  expect(isDeepHighEscalation(output)).toBe(expected)
})

test("sync lifecycle keeps the decision through cloning, category mutation and archive continuation", async () => {
  const records: ledger.JevRoutingRecord[] = []
  const completed = Promise.withResolvers<void>()
  const ledgerSpy = spyOn(ledger, "recordJevRouting").mockImplementation(async (record) => {
    records.push(record)
    if (record.event === "outcome") completed.resolve()
  })
  const args = {
    description: "Task",
    prompt: "Private prompt",
    category: "auto",
    run_in_background: false,
    load_skills: [],
  }
  const decisionId = beginJevDecision(args)
  const cloned = { ...args, category: "deep-low" }
  const client = unsafeTestValue({
    session: {
      messages: async () => ({
        data: [
          {
            info: { role: "assistant", providerID: "test", modelID: "producing" },
            parts: [{ type: "text", text: "ESCALATE: deep-high\nDetails" }],
          },
        ],
      }),
      abort: async () => ({}),
    },
  })
  let dispatchedAt: Date | undefined
  try {
    const result = await executeSyncTask(
      cloned,
      unsafeTestValue({ sessionID: "parent", messageID: "message", abort: new AbortController().signal }),
      unsafeTestValue({ client, manager: {}, directory: process.cwd() }),
      { sessionID: "parent", messageID: "message" },
      "worker",
      { providerID: "test", modelID: "selected" },
      undefined,
      undefined,
      undefined,
      {
        createSyncSession: async () => ({ ok: true, sessionID: "sync-child", parentDirectory: process.cwd() }),
        sendSyncPrompt: async () => {
          dispatchedAt = getRegisteredBackgroundTask("sync_sync-child")?.startedAt
          return null
        },
        pollSyncSession: async () => null,
        fetchSyncResult: async () => ({ ok: true, textContent: "ESCALATE: deep-high\nDetails" }),
      },
    )
    expect(result).toContain("ESCALATE: deep-high")
    const record = findRegisteredBackgroundTaskBySession("sync-child", "parent")
    expect(record).toMatchObject({
      id: "sync_sync-child",
      decisionId,
      status: "completed",
      spawnDepth: 1,
      concurrencyGroup: "test/selected",
    })
    expect(record?.startedAt).toBeInstanceOf(Date)
    expect(record?.startedAt).toEqual(dispatchedAt)
    await completed.promise
    expect(records.find((record) => record.event === "outcome")).toMatchObject({
      decision_id: decisionId,
      status: "escalated",
      producing_model: "test/producing",
    })
    const firstAttempt = record?.currentAttemptID
    const continued = resumeSyncLifecycleTask("sync-child", "parent")
    expect(continued?.decisionId).toBe(decisionId)
    expect(continued?.currentAttemptID).not.toBe(firstAttempt)
    expect(continued?.attempts?.at(-1)?.cause).toBe("continuation")
  } finally {
    ledgerSpy.mockRestore()
    clearBackgroundTaskRegistryForTesting()
  }
})

test("managed sync continuation leaves its manager-owned terminal task and claim unchanged", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-managed-sync-"))
  const records: ledger.JevRoutingRecord[] = []
  const completed = Promise.withResolvers<void>()
  const recordSpy = spyOn(ledger, "recordJevRouting").mockImplementation(async (record) => {
    records.push(record)
    if (record.event === "outcome") completed.resolve()
  })
  const task: BackgroundTask = {
    id: "bg_managed",
    decisionId: crypto.randomUUID(),
    sessionId: "managed-child",
    parentSessionId: "managed-parent",
    parentMessageId: "message",
    description: "Task",
    prompt: "Private prompt",
    agent: "worker",
    status: "completed",
    model: { providerID: "test", modelID: "selected" },
    startedAt: new Date("2026-01-01T00:00:00Z"),
    completedAt: new Date("2026-01-01T00:01:00Z"),
    currentAttemptID: "att_original",
    attempts: [
      {
        attemptId: "att_original",
        attemptNumber: 1,
        status: "completed",
        sessionId: "managed-child",
        lifecycleCompleted: true,
      },
    ],
  }
  const snapshot = structuredClone(task)
  const attempts = task.attempts
  const client = unsafeTestValue({
    session: {
      get: async () => ({ data: { id: "managed-child", parentID: "managed-parent", directory } }),
      messages: async () => ({
        data: [
          {
            info: {
              id: "assistant",
              role: "assistant",
              providerID: "test",
              modelID: "actual",
              agent: "worker",
              finish: "stop",
            },
            parts: [{ type: "text", text: "Done" }],
          },
        ],
      }),
      promptAsync: async () => ({ data: {} }),
      abort: async () => ({ data: {} }),
    },
  })
  const manager = new BackgroundManager({
    pluginContext: unsafeTestValue({ directory, client }),
    enableParentSessionNotifications: false,
  })
  manager.adoptRetainedTask(task)
  try {
    const result = await executeSyncContinuation(
      {
        description: "Continue",
        prompt: "Followup",
        task_id: "managed-child",
        load_skills: [],
        run_in_background: false,
      },
      unsafeTestValue({
        sessionID: "managed-parent",
        messageID: "message",
        agent: "sisyphus",
        abort: new AbortController().signal,
      }),
      { client, manager, directory },
      { sessionID: "managed-parent", messageID: "message" },
      {
        pollSyncSession: async () => {
          expect(task).toEqual(snapshot)
          expect(task.attempts).toBe(attempts)
          expect(manager.hasActiveChildTasks("managed-parent")).toBe(false)
          expect(() => manager.claimSyncContinuation("managed-child", "managed-parent")).toThrow(
            "active sync continuation",
          )
          await manager.handleEvent({ type: "session.idle", properties: { sessionID: "managed-child" } })
          expect(task).toEqual(snapshot)
          return null
        },
        fetchSyncResult: async () => ({ ok: true, textContent: "Done" }),
      },
    )
    expect(result).toContain("Done")
    await completed.promise
    expect(task).toEqual(snapshot)
    expect(manager.getTask(task.id)).toBe(task)
    expect(records.filter((record) => record.event === "outcome")).toHaveLength(1)
    expect(records.find((record) => record.event === "attempt" && record.child_session_id !== null)).toMatchObject({
      decision_id: task.decisionId,
      task_id: task.id,
      cause: "continuation",
    })
  } finally {
    await manager.shutdown()
    recordSpy.mockRestore()
    clearBackgroundTaskRegistryForTesting()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("sync completion returns while its attributable evidence read remains pending", async () => {
  const outcome = Promise.withResolvers<ledger.JevRoutingRecord>()
  const recordSpy = spyOn(ledger, "recordJevRouting").mockImplementation(async (record) => {
    if (record.event === "outcome") outcome.resolve(record)
  })
  const response = Promise.withResolvers<unknown>()
  const args = {
    description: "Task",
    prompt: "Private",
    category: "deep-low",
    decisionId: crypto.randomUUID(),
    run_in_background: false,
    load_skills: [],
  }
  const client = unsafeTestValue({ session: { messages: async () => response.promise, abort: async () => ({}) } })
  try {
    const result = await executeSyncTask(
      args,
      unsafeTestValue({ sessionID: "parent", messageID: "message", abort: new AbortController().signal }),
      unsafeTestValue({ client, manager: {}, directory: process.cwd() }),
      { sessionID: "parent", messageID: "message" },
      "worker",
      { providerID: "test", modelID: "selected" },
      undefined,
      undefined,
      undefined,
      {
        createSyncSession: async () => ({
          ok: true,
          sessionID: "pending-evidence-child",
          parentDirectory: process.cwd(),
        }),
        sendSyncPrompt: async () => null,
        pollSyncSession: async () => null,
        fetchSyncResult: async () => ({ ok: true, textContent: "Done" }),
      },
    )
    expect(result).toContain("Done")
    response.resolve({
      data: [
        { info: { role: "assistant", providerID: "test", modelID: "actual" }, parts: [{ type: "text", text: "Done" }] },
      ],
    })
    expect(await outcome.promise).toMatchObject({
      event: "outcome",
      decision_id: args.decisionId,
      task_id: "sync_pending-evidence-child",
      producing_model: "test/actual",
    })
  } finally {
    recordSpy.mockRestore()
    clearBackgroundTaskRegistryForTesting()
  }
})
