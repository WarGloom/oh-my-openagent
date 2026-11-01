import type { Hooks } from "@opencode-ai/plugin"
import type { V2PluginContext, V2Registration } from "./context-types"
import { installConfigBridge, type BeforeCommandHook, type ConfigHook } from "./config-bridge"
import { toV2Tool } from "./tool-bridge"
import { installToolHooks } from "./tool-hooks"
import { installSessionHooks } from "./session-hooks"

export type InstallHooksDeps = {
  readonly warn: (message: string) => void
}

/**
 * Registers what a V1 `Hooks` object defines onto the matching 2.x domains and returns one
 * disposer for everything it registered. Tools, the `config` hook (agents, MCP servers, commands) and
 * the tool execute hooks are mapped so far; the other hooks are added one domain at a time as their
 * 2.x counterparts are wired.
 */
export async function installHooks(
  context: V2PluginContext,
  hooks: Hooks,
  deps: InstallHooksDeps,
): Promise<() => Promise<void>> {
  const registrations: V2Registration[] = []

  const tools = Object.entries(hooks.tool ?? {})
  if (tools.length > 0) {
    const bridge = {
      directory: context.location.directory,
      worktree: context.location.project.canonical,
      warn: deps.warn,
    }
    registrations.push(
      await context.tool.transform((editor) => {
        for (const [name, definition] of tools) {
          // OpenCode 2.x disables the whole plugin when a transform throws, so one tool that cannot
          // be converted is skipped and named instead of taking every other tool down with it.
          try {
            editor.add(toV2Tool(name, definition, bridge))
          } catch (error) {
            deps.warn(`Skipping tool "${name}": ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }),
    )
  }

  if (hooks.config !== undefined) {
    const dispose = await installConfigBridge(context, hooks.config as unknown as ConfigHook, {
      warn: deps.warn,
      ...(hooks["command.execute.before"] === undefined
        ? {}
        : { beforeCommand: hooks["command.execute.before"] as unknown as BeforeCommandHook }),
    })
    registrations.push({ dispose })
  }

  if (hooks["tool.execute.before"] !== undefined || hooks["tool.execute.after"] !== undefined) {
    registrations.push({ dispose: await installToolHooks(context, hooks) })
  }

  const bridgesSessionHook =
    hooks["chat.message"] !== undefined ||
    hooks["chat.params"] !== undefined ||
    hooks["chat.headers"] !== undefined ||
    hooks["experimental.chat.system.transform"] !== undefined ||
    hooks["experimental.chat.messages.transform"] !== undefined ||
    hooks["experimental.session.compacting"] !== undefined
  if (bridgesSessionHook) {
    registrations.push({ dispose: await installSessionHooks(context, hooks, { warn: deps.warn }) })
  }

  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    for (const registration of registrations.reverse()) await registration.dispose()
  }
}
