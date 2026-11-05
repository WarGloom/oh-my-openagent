import { z } from "zod"
import type { createAtlasHook } from "../hooks/atlas/atlas-hook"
import type { V2PluginContext, V2Registration } from "./context-types"

const completionMetadata = z.object({
  source: z.literal("subagent"),
  childID: z.string(),
  agent: z.string(),
  state: z.enum(["completed", "error", "cancelled"]),
})

export async function registerNativeAtlasCompletion(
  context: V2PluginContext,
  atlas: Pick<ReturnType<typeof createAtlasHook>, "nativeCompletion">,
): Promise<V2Registration> {
  const processed = new Set<string>()
  const registration = await context.session.hook("context", async (event) => {
    const visible = new Set(event.messages.flatMap((message) => (typeof message.id === "string" ? [message.id] : [])))
    const history = await context.session.context({ sessionID: event.sessionID })
    const latestUser = history.findLastIndex((record) => record.type === "user")
    for (const record of history.slice(latestUser + 1)) {
      if (record.type !== "synthetic" || !visible.has(record.id) || processed.has(record.id)) continue
      const metadata = completionMetadata.safeParse(record.metadata)
      if (!metadata.success) continue
      const reminder = await atlas.nativeCompletion({
        sessionID: event.sessionID,
        childSessionID: metadata.data.childID,
        agent: metadata.data.agent,
        state: metadata.data.state,
        text: record.text,
      })
      processed.add(record.id)
      if (reminder) event.system.push({ type: "text", text: reminder })
    }
  })
  return {
    dispose: async () => {
      await registration.dispose()
      processed.clear()
    },
  }
}
