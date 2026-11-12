import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BackgroundManager } from "../features/background-agent/manager"
import type { LaunchInput } from "../features/background-agent/types"
import { clearBackgroundTaskRegistryForTesting } from "../features/background-agent/task-registry"
import { createFakePluginContext } from "./fake-plugin-context"
import { bindV2BackgroundJobs, createPluginInput } from "./create-plugin-input"
import { createSessionTracker } from "./session-tracker"
import { V2NativeSubagentJobs, type NativeDelegationSkills } from "./native-subagent-jobs"
import type { NativeSubagentDomain, NativeSubagentReceipt } from "./native-subagent-types"
import type { NativeSubagentPrompt } from "./native-subagent-types"
import { backgroundTaskRecord, encodeBackgroundTask } from "./background-task-record"
import { createNativeRecoveryNotifier } from "./native-recovery-notice"
import { V2BackgroundLifecycle } from "./background-lifecycle"
import { spyOn } from "bun:test"
import { createDelegateTask } from "../tools/delegate-task/tools"
import type { DelegateTaskArgs } from "../tools/delegate-task/types"
import * as ledger from "../tools/delegate-task/jev-routing-ledger"
import { createToolExecuteBeforeHandler } from "../plugin/tool-execute-before"
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"

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
    readonly cleanupDelay?: number
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
  const input = createPluginInput(context, { tracker: createSessionTracker(), warn: () => {} })
  if (!context.storage) throw new Error("fake storage missing")
  const lifecycle = new V2BackgroundLifecycle(context, context.storage)
  const save = async (task: Parameters<typeof encodeBackgroundTask>[0]) => {
    stored.set(task.id, encodeBackgroundTask(task))
    await lifecycle.save(task)
  }
  const createJobs = () =>
    new V2NativeSubagentJobs(context, domain, {
      load: (sessionID, parentSessionID) => lifecycle.findRetainedTask(sessionID, parentSessionID),
      activateSkills: async () =>
        options.activate
          ? options.activate()
          : { text: "skill content", activationIDs: ["activation-1"], selections: [{ id: "skill" }] },
      restoreSkills: async () => ({ text: options.restoredText ?? "accepted skill content" }),
      save,
      notifyRecovery: createNativeRecoveryNotifier(context, input, () => true),
    })
  const manager = new BackgroundManager({
    pluginContext: input,
    config: { defaultConcurrency: 1, taskCleanupDelayMs: options.cleanupDelay },
    nativeJobs: createJobs(),
    nativeLifecycle: {
      save,
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
    domain,
    context,
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

export async function completedFixture(status: "completed" | "error" = "completed", requiredModel?: string) {
  const record = spyOn(ledger, "recordJevRouting").mockResolvedValue(undefined)
  cleanups.push(() => record.mockRestore())
  const f = await fixture({ cleanupDelay: 0 })
  const get = f.context.session.get
  const session = spyOn(f.context.session, "get").mockImplementation(async (input) => ({
    ...(await get(input)),
    ...(input.sessionID === "parent" ? {} : { parentID: "parent", agent: "worker" }),
  }))
  cleanups.push(() => session.mockRestore())
  const started = f.nextStart()
  const task = await f.manager.launch({
    ...f.launch("initial"),
    decisionId: crypto.randomUUID(),
    category: "retained",
    skills: ["skill"],
    ...(requiredModel ? { nativeMetadata: { requiredModel } } : {}),
  })
  await started
  const removed = Promise.withResolvers<void>()
  cleanups.push(
    f.manager.onVisibleChange(() => {
      if (!f.manager.findBySession(task.sessionId ?? "")) removed.resolve()
    }),
  )
  const completed = f.manager.waitForNativeTask(task.id, new AbortController().signal)
  f.finish(task.nativeAdmissionID ?? "", status)
  await completed
  await removed.promise
  const retained = backgroundTaskRecord.parse(f.stored.get(task.id))
  const sessionID = task.sessionId
  if (!sessionID) throw new Error("native child missing")
  const execute = async (
    manager: BackgroundManager,
    callID = "continue",
    selection: Pick<DelegateTaskArgs, "subagent_type" | "required_model" | "category"> = {},
  ) => {
    const context = {
      sessionID: "parent",
      messageID: "followup-message",
      agent: "parent-agent",
      callID,
      abort: new AbortController().signal,
      directory: f.input.directory,
      worktree: f.input.directory,
      ask: async () => {},
      metadata: async () => {},
    }
    if (!manager.nativeJobs) throw new Error("Native continuation fixture requires native jobs")
    bindV2BackgroundJobs(f.input, manager.nativeJobs)
    const output = {
      args: {
        task_id: sessionID,
        prompt: "followup",
        description: "continue retained",
        run_in_background: true,
        load_skills: [],
        ...selection,
      },
    }
    await createToolExecuteBeforeHandler({ ctx: f.input, hooks: unsafeTestValue({}) })(
      { tool: "task", sessionID: context.sessionID, callID },
      output,
    )
    return createDelegateTask({ manager, client: f.input.client, directory: f.input.directory }).execute(
      output.args,
      context,
    )
  }
  return { ...f, task, sessionID, retained, execute, session }
}
