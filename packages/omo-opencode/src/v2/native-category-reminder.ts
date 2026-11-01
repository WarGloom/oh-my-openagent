import { createHash } from "node:crypto"
import type { createCategorySkillReminderHook } from "../hooks/category-skill-reminder/hook"
import { log } from "../shared/logger"
import type { V2PluginContext, V2Registration } from "./context-types"

export async function registerNativeCategoryReminder(
  context: V2PluginContext,
  hook: ReturnType<typeof createCategorySkillReminderHook>,
): Promise<V2Registration> {
  return context.session.hook("context", async (event) => {
    const reminder = hook.nativeReminder(event.sessionID)
    if (reminder === undefined) return
    try {
      const history = await context.session.context({ sessionID: event.sessionID })
      const records = new Map(history.map((record) => [record.id, record]))
      const messages = event.messages.map((message) => {
        const synthetic = typeof message.id === "string" && records.get(message.id)?.type === "synthetic"
        const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content
        return {
          info: { role: message.role, sessionID: event.sessionID, id: message.id },
          parts: parts.map((part) => ({ type: part.type, text: part.text, synthetic })),
        }
      })
      if (!hook.nativeHasReminderTarget(messages)) return
      const digest = createHash("sha256").update(`category-reminder\0${event.sessionID}`).digest("hex")
      await context.session.synthetic({ sessionID: event.sessionID, id: `msg_${digest}`, text: reminder, delivery: "steer", resume: false })
      hook.nativeMarkReminder(event.sessionID)
    } catch (error) {
      log("[v2] category reminder admission failed", { sessionID: event.sessionID, error })
    }
  })
}
