import type { V2PluginContext, V2Registration } from "./context-types"

const transientSystems = new WeakMap<V2PluginContext, Map<string, string>>()

export async function setSessionSystem(context: V2PluginContext, sessionID: string, system: string): Promise<void> {
  if (context.storage) {
    await context.storage.set(`session-system/${sessionID}`, system)
    return
  }
  const systems = transientSystems.get(context) ?? new Map<string, string>()
  systems.set(sessionID, system)
  transientSystems.set(context, systems)
}

export function registerSessionSystem(context: V2PluginContext): Promise<V2Registration> {
  return context.session.hook("context", async (event) => {
    const system = context.storage
      ? await context.storage.get(`session-system/${event.sessionID}`)
      : transientSystems.get(context)?.get(event.sessionID)
    if (typeof system === "string" && system.length > 0) event.system.push({ type: "text", text: system })
  })
}
