import { createHash } from "node:crypto"
import type { createCategorySkillReminderHook } from "../hooks/category-skill-reminder/hook"
import { isRealUserTextPart } from "../shared/internal-initiator-marker"
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
      const realUser = event.messages.some((message) => {
        if (message.role !== "user" || typeof message.id !== "string") return false
        const synthetic = records.get(message.id)?.type === "synthetic"
        const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content
        return parts.some((part) => isRealUserTextPart({ type: part.type, text: part.text, synthetic }))
      })
      if (!realUser) return
      const digest = createHash("sha256").update(`category-reminder\0${event.sessionID}`).digest("hex")
      await context.session.synthetic({ sessionID: event.sessionID, id: `msg_${digest}`, text: reminder, delivery: "steer", resume: false })
      hook.nativeMarkReminder(event.sessionID)
    } catch (error) {
      log("[v2] category reminder admission failed", { sessionID: event.sessionID, error })
    }
  })
}
