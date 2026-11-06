import type { Hooks, Plugin } from "@opencode-ai/plugin"
import type { V2Cleanup, V2PluginContext, V2Registration } from "./context-types"
import { bindV2BackgroundJobs, createPluginInput, getV2DashboardOwners } from "./create-plugin-input"
import { startEventBridge } from "./event-bridge"
import { installHooks } from "./install-hooks"
import { createSessionTracker } from "./session-tracker"
import { log } from "../shared/logger"
import { installNativeRuntimeFallback } from "./native-runtime-fallback"
import { V2BackgroundLifecycle } from "./background-lifecycle"
import { registerSessionSystem } from "./session-system"
import { toastChannel, type V2ToastRegistration } from "./toast-channel"
import { installNativeSkills } from "./native-skills"
import { V2NativeSubagentJobs } from "./native-subagent-jobs"
import { activateNativeSubagentSkills } from "./native-skill-delegation"
import { restoreNativeSkills } from "./native-skill-restore"
import { bindNativeIdleArbiter, NativeIdleArbiter } from "./native-idle-arbiter"
import { isNativeRecoveryPending } from "./native-recovery-state"
import { settleCompactionRestore } from "./compaction-continuation"
import { registerNativeDashboard } from "./native-dashboard"

export type V2SetupDeps = {
  readonly serverPlugin: Plugin
  readonly warn?: (message: string) => void
}

const warnOnce = (): ((message: string) => void) => {
  const seen = new Set<string>()
  return (message) => {
    if (seen.has(message)) return
    seen.add(message)
    log(`[v2] ${message}`)
  }
}

/**
 * OpenCode 2.x entry: runs the V1 plugin body once against a V1-shaped input derived from the V2
 * context, installs what its hooks define onto the 2.x domains, and returns the cleanup V2 calls
 * when the plugin unloads.
 */
export function createV2Setup(deps: V2SetupDeps): (context: V2PluginContext) => Promise<V2Cleanup> {
  const warn = deps.warn ?? warnOnce()
  return async (context) => {
    if (!context.storage) throw new Error("Native background jobs require host storage")
    if (!context.experimental.subagent) throw new Error("Native background jobs require the host subagent domain")
    const tracker = createSessionTracker()
    const bridge = startEventBridge(context, { tracker, warn })
    let hooks: Hooks | undefined
    let uninstall: (() => Promise<void>) | undefined
    let fallback: Awaited<ReturnType<typeof installNativeRuntimeFallback>>
    let toast: V2ToastRegistration | undefined
    let sessionSystem: V2Registration | undefined
    let skills: V2Registration | undefined
    let arbiter: NativeIdleArbiter | undefined
    let idleListener: V2Registration | undefined
    let dashboard: V2Registration | undefined
    const background = new V2BackgroundLifecycle(context, context.storage)
    try {
      toast = await context.rpc.register(toastChannel, {})
      const toastEvents = toast.events
      sessionSystem = await registerSessionSystem(context)
      await background.load()
      let cursor: string | null | undefined
      do {
        const page = await context.session.list({ directory: context.location.directory, ...(cursor == null ? {} : { cursor }) })
        tracker.seed(page.data)
        cursor = page.cursor.next
      } while (cursor)
      const input = createPluginInput(context, { tracker, warn, emitToast: (body) => toastEvents.emit("toast", body) }, background)
      const jobs = new V2NativeSubagentJobs(context, context.experimental.subagent, {
        save: (task) => background.save(task),
        activateSkills: (task) => {
          if (!task.nativeAdmissionID || !task.nativePromptID || !task.sessionId) throw new Error("Native skill acceptance requires a prepared task")
          return activateNativeSubagentSkills(input, {
            admissionID: task.nativeAdmissionID, promptID: task.nativePromptID, sessionID: task.sessionId, agent: task.agent,
            names: task.skills ?? [], commandSkills: task.nativePrompt?.skills,
          })
        },
        restoreSkills: (task) => {
          if (!task.sessionId) throw new Error("Native skill replay requires a child session")
          return restoreNativeSkills(input, {
            sessionID: task.sessionId, agent: task.agent, activationIDs: task.nativeSkillActivationIDs ?? [],
          })
        },
      })
      bindV2BackgroundJobs(input, jobs)
      arbiter = new NativeIdleArbiter(context, {
        isNativeRecoveryPending, settleCompactionRestore,
        hasPendingWork: (sessionID) => background.hasPendingWork(sessionID),
      })
      bindNativeIdleArbiter(input, arbiter)
      idleListener = arbiter.onIdle((event) => background.onIdle(event))
      await arbiter.start()
      hooks = await deps.serverPlugin(input, { ...context.options })
      skills = await installNativeSkills(input)
      fallback = await installNativeRuntimeFallback(context, hooks)
      bridge.setInterceptor(fallback?.beforeEvent)
      uninstall = await installHooks(context, hooks, { warn })
      dashboard = await registerNativeDashboard(context, getV2DashboardOwners(context))
      if (fallback) {
        const installedFallback = fallback
        const uninstallHooks = uninstall
        uninstall = async () => {
          await installedFallback.dispose()
          await uninstallHooks()
        }
      }
      bridge.setHandler(hooks.event)
      await background.start()
    } catch (error) {
      bridge.stop()
      await dashboard?.dispose()
      await idleListener?.dispose()
      await arbiter?.dispose()
      await background.dispose()
      await fallback?.dispose()
      await uninstall?.()
      await skills?.dispose()
      await sessionSystem?.dispose()
      await hooks?.dispose?.()
      await toast?.dispose()
      throw error
    }
    let disposed = false
    return async () => {
      if (disposed) return
      disposed = true
      bridge.stop()
      await dashboard?.dispose()
      await idleListener?.dispose()
      await arbiter?.dispose()
      await background.dispose()
      await uninstall?.()
      await skills?.dispose()
      await sessionSystem?.dispose()
      await hooks?.dispose?.()
      await toast?.dispose()
    }
  }
}
