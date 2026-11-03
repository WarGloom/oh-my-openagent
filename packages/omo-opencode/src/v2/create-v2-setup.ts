import type { Hooks, Plugin } from "@opencode-ai/plugin"
import type { V2Cleanup, V2PluginContext } from "./context-types"
import { createPluginInput } from "./create-plugin-input"
import { startEventBridge } from "./event-bridge"
import { installHooks } from "./install-hooks"
import { createSessionTracker } from "./session-tracker"
import { log } from "../shared/logger"
import { installNativeRuntimeFallback } from "./native-runtime-fallback"
import { V2BackgroundLifecycle } from "./background-lifecycle"
import { toastChannel, type V2ToastRegistration } from "./toast-channel"

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
    const tracker = createSessionTracker()
    const bridge = startEventBridge(context, { tracker, warn })
    let hooks: Hooks | undefined
    let uninstall: (() => Promise<void>) | undefined
    let fallback: Awaited<ReturnType<typeof installNativeRuntimeFallback>>
    let toast: V2ToastRegistration | undefined
    const background = context.storage ? new V2BackgroundLifecycle(context, context.storage) : undefined
    try {
      toast = await context.rpc.register(toastChannel, {})
      const toastEvents = toast.events
      await background?.load()
      let cursor: string | null | undefined
      do {
        const page = await context.session.list({ directory: context.location.directory, ...(cursor == null ? {} : { cursor }) })
        tracker.seed(page.data)
        cursor = page.cursor.next
      } while (cursor)
      const input = createPluginInput(context, { tracker, warn, emitToast: (body) => toastEvents.emit("toast", body) }, background)
      hooks = await deps.serverPlugin(input, { ...context.options })
      fallback = await installNativeRuntimeFallback(context, hooks)
      bridge.setInterceptor(fallback?.beforeEvent)
      uninstall = await installHooks(context, hooks, { warn })
      if (fallback) {
        const installedFallback = fallback
        const uninstallHooks = uninstall
        uninstall = async () => {
          await installedFallback.dispose()
          await uninstallHooks()
        }
      }
      bridge.setHandler(hooks.event)
      await background?.start()
    } catch (error) {
      bridge.stop()
      await background?.dispose()
      await fallback?.dispose()
      await uninstall?.()
      await hooks?.dispose?.()
      await toast?.dispose()
      throw error
    }
    let disposed = false
    return async () => {
      if (disposed) return
      disposed = true
      bridge.stop()
      await background?.dispose()
      await uninstall?.()
      await hooks?.dispose?.()
      await toast?.dispose()
    }
  }
}
