import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BackgroundManager } from "../features/background-agent/manager"
import type { LaunchInput } from "../features/background-agent/types"
import { clearBackgroundTaskRegistryForTesting } from "../features/background-agent/task-registry"
import { createFakePluginContext } from "./fake-plugin-context"
import { createPluginInput } from "./create-plugin-input"
import { createSessionTracker } from "./session-tracker"
import { V2NativeSubagentJobs, type NativeDelegationSkills } from "./native-subagent-jobs"
import type { NativeSubagentDomain, NativeSubagentReceipt } from "./native-subagent-types"
import type { NativeSubagentPrompt } from "./native-subagent-types"
import { encodeBackgroundTask } from "./background-task-record"

export const cleanups: Array<() => void | Promise<void>> = []
// Each importing test file registers this in its own afterEach: a hook registered at module import
// belongs only to the first file that loads this module, so later files would leak their fixtures.
export async function cleanupNativeFixtures(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  clearBackgroundTaskRegistryForTesting()
}

export async function fixture(
  options: {
    readonly activate?: () => Promise<NativeDelegationSkills>
    readonly restoredText?: string
    readonly denied?: boolean
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "omo-native-jobs-"))
  cleanups.push(() => rmSync(directory, { force: true, recursive: true }))
  const fake = createFakePluginContext({
    directory,
    sessionAgent: "parent-agent",
    sessionInfo: { model: { providerID: "test", id: "model" } },
  })
  const rows = new Map<string, NativeSubagentReceipt>()
  const completions = new Map<string, ReturnType<typeof Promise.withResolvers<NativeSubagentReceipt>>>()
  const instructions = new Map<string, string>()
  const stored = new Map<string, ReturnType<typeof encodeBackgroundTask>>()
  const starts: string[] = []
  const prompts: NativeSubagentPrompt[] = []
  const notices: string[] = []
  const ready: string[] = []
  const startListeners: Array<() => void> = []
  let generation = 0
  const anchors = new Set<string>()
  const revoked = new Set<string>()
  const current = (target: Parameters<NativeSubagentDomain["get"]>[0]) =>
    [...rows.values()].find((row) =>
      "admissionID" in target ? row.admissionID === target.admissionID : row.run?.generation === target.run.generation,
    )
  const domain: NativeSubagentDomain = {
    prepare: async (input) => {
      if (options.denied) throw new Error("permission denied")
      if (input.invocation.kind === "team" && revoked.has(input.invocation.provisioningAdmissionID))
        throw new Error("Provisioning anchor revoked")
      if (input.invocation.kind === "tool" && input.invocation.team) anchors.add(input.admissionID)
      const previous = rows.get(input.admissionID)
      if (previous) return previous
      const receipt: NativeSubagentReceipt = {
        admissionID: input.admissionID,
        parentSessionID: input.parentSessionID,
        childSessionID: input.target.kind === "existing" ? input.target.sessionID : `child-${rows.size + 1}`,
        status: "prepared",
      }
      rows.set(input.admissionID, receipt)
      return receipt
    },
    start: async (input) => {
      const prepared = rows.get(input.admissionID)
      if (!prepared) throw new Error("unprepared start")
      if (prepared.status !== "prepared") return prepared
      if (!instructions.has(prepared.childSessionID)) throw new Error("child bootstrap missing before wake")
      const active = [...rows.values()].find(
        (row) => row.childSessionID === prepared.childSessionID && row.status === "running",
      )
      if (!active?.run) generation += 1
      const run = active?.run ?? { childSessionID: prepared.childSessionID, generation: String(generation) }
      const receipt: NativeSubagentReceipt = {
        ...prepared,
        promptID: input.promptID,
        completion: input.completion,
        status: "running",
        run,
      }
      rows.set(input.admissionID, receipt)
      if (!completions.has(run.generation))
        completions.set(run.generation, Promise.withResolvers<NativeSubagentReceipt>())
      starts.push(prepared.childSessionID)
      prompts.push(input.prompt)
      startListeners.shift()?.()
      return receipt
    },
    get: async (target) => current(target),
    wait: async ({ run }) => {
      const completion = completions.get(run.generation)
      if (!completion) throw new Error("unknown generation")
      return { receipt: await completion.promise, timedOut: false }
    },
    cancel: async (target) => {
      const receipt = current(target)
      if (!receipt) throw new Error("unknown admission")
      const anchor = "admissionID" in target && anchors.has(receipt.admissionID)
      if (anchor) revoked.add(receipt.admissionID)
      const terminal = receipt.status === "completed" || receipt.status === "error" || receipt.status === "cancelled"
      const cancelled = {
        ...receipt,
        ...(terminal ? {} : { status: "cancelled" as const }),
        ...(anchor ? { revoked: true as const } : {}),
      }
      rows.set(receipt.admissionID, cancelled)
      if (receipt.run) completions.get(receipt.run.generation)?.resolve(cancelled)
      return cancelled
    },
    reconcile: async () => [...rows.values()],
    ready: async ({ run }) => {
      const receipt = current({ run })
      if (!receipt || !instructions.has(run.childSessionID)) throw new Error("unrestored child")
      ready.push(run.generation)
      return receipt
    },
  }
  const context = {
    ...fake.context,
    session: {
      ...fake.context.session,
      instructions: {
        entry: {
          put: async ({ sessionID, value }: { sessionID: string; key: string; value: string }) => {
            instructions.set(sessionID, value)
          },
          remove: async () => {},
        },
      },
    },
  }
  const createJobs = () =>
    new V2NativeSubagentJobs(context, domain, {
      activateSkills: async () =>
        options.activate
          ? options.activate()
          : { text: "skill content", activationIDs: ["activation-1"], selections: [{ id: "skill" }] },
      restoreSkills: async () => ({ text: options.restoredText ?? "accepted skill content" }),
      save: async (task) => {
        stored.set(task.id, encodeBackgroundTask(task))
      },
    })
  const input = createPluginInput(context, { tracker: createSessionTracker(), warn: () => {} })
  const manager = new BackgroundManager({
    pluginContext: input,
    config: { defaultConcurrency: 1 },
    nativeJobs: createJobs(),
    nativeLifecycle: {
      save: async (task) => {
        stored.set(task.id, encodeBackgroundTask(task))
      },
      notify: async (task) => {
        notices.push(task.id)
      },
    },
    preserveSessionsOnShutdown: true,
  })
  await manager.restoreNativeJobs()
  cleanups.push(() => manager.shutdown())
  const launch = (call: string): LaunchInput => ({
    parentSessionId: "parent",
    parentMessageId: "message",
    agent: "worker",
    description: "work",
    prompt: call,
    skillContent: "system",
    model: { providerID: "test", modelID: "model" },
    nativeInvocation: { kind: "tool", agent: "parent-agent", messageID: "message", toolCallID: call },
  })
  const finish = (admissionID: string, status: "completed" | "error" = "completed") => {
    const receipt = rows.get(admissionID)
    if (!receipt?.run) throw new Error("run missing")
    const terminal = { ...receipt, status, output: "child result", ...(status === "error" ? { error: "failed" } : {}) }
    rows.set(admissionID, terminal)
    completions.get(receipt.run.generation)?.resolve(terminal)
  }
  return {
    manager,
    createJobs,
    input,
    fake,
    starts,
    prompts,
    notices,
    ready,
    stored,
    launch,
    finish,
    rows,
    instructions,
    nextStart: () =>
      new Promise<void>((resolve) => {
        startListeners.push(resolve)
      }),
  }
}
