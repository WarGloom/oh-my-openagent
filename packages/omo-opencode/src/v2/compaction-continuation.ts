import type { CompactionAutocontinueHook } from "../plugin/session-compacting"
import type { V2PluginContext, V2Registration } from "./context-types"

const restorations = new Map<string, Promise<boolean>>()

/** The idle arbiter awaits restoration but does not create another continuation. */
export async function settleCompactionRestore(sessionID: string): Promise<void> {
  await restorations.get(sessionID)
}

export async function registerCompactionContinuation(
  context: V2PluginContext,
  handler: CompactionAutocontinueHook,
): Promise<V2Registration> {
  const outcomes = new Map<string, { readonly compactionID: string; readonly result: Promise<boolean> }>()
  const registration = await context.session.hook("experimental.compaction.continue", async (event) => {
    const previous = outcomes.get(event.sessionID)
    const result =
      previous?.compactionID === event.compactionID
        ? previous.result
        : (async () => {
            const output = { enabled: event.enabled }
            await handler(
              {
                sessionID: event.sessionID,
                agent: event.agent,
                model: event.model,
                overflow: event.reason === "overflow",
              },
              output,
            )
            return output.enabled
          })()
    outcomes.set(event.sessionID, { compactionID: event.compactionID, result })
    restorations.set(event.sessionID, result)
    try {
      event.enabled = (await result) && event.enabled
    } catch (error) {
      if (outcomes.get(event.sessionID)?.result === result) outcomes.delete(event.sessionID)
      throw error
    } finally {
      if (restorations.get(event.sessionID) === result) restorations.delete(event.sessionID)
    }
  })
  return {
    dispose: async () => {
      await registration.dispose()
      outcomes.clear()
    },
  }
}
