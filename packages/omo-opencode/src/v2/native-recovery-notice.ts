import { createHash } from "node:crypto"
import type { PluginInput } from "@opencode-ai/plugin"
import type { BackgroundTask } from "../features/background-agent/types"
import { dispatchInternalPrompt } from "../shared/prompt-async-gate"
import type { V2PluginContext } from "./context-types"

export function createNativeRecoveryNotifier(
  context: V2PluginContext,
  input: PluginInput,
  shouldDispatch: () => boolean,
) {
  return async (task: BackgroundTask, error: string): Promise<void> => {
    const id = `msg_${createHash("sha256")
      .update(`recovery:${task.nativeAdmissionID ?? task.id}`)
      .digest("hex")
      .slice(0, 26)}`
    const text = `Background task ${task.id} (${task.description}) failed during recovery: ${error}`
    const result = await dispatchInternalPrompt({
      mode: "async",
      sessionID: task.parentSessionId,
      source: "background-agent-parent-wake",
      dedupeKey: id,
      queueBehavior: "enqueue",
      shouldDispatch,
      client: {
        session: {
          status: () => input.client.session.status(),
          messages: (args) => input.client.session.messages(args),
          promptAsync: async () =>
            context.session.synthetic({
              sessionID: task.parentSessionId,
              id,
              text,
              description: task.description,
              delivery: "steer",
              resume: true,
            }),
        },
      },
      input: {
        path: { id: task.parentSessionId },
        body: { parts: [{ type: "text", text, synthetic: true }] },
        query: { directory: input.directory },
      },
    })
    if (result.status === "failed") throw result.error
  }
}
