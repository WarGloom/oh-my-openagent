import { z } from "zod"
import { log } from "../../shared/logger"
import { runWithAbortBudget } from "../../shared/abort-budget"
import { hasNativeSdkStorage } from "../../shared/opencode-storage-detection"

export type TaskTerminalEvidence = { readonly producingModel?: string; readonly output?: string }
export const TERMINAL_EVIDENCE_TIMEOUT_MS = 250
const messages = z
  .array(
    z.object({
      info: z
        .object({
          role: z.string().optional(),
          providerID: z.string().optional(),
          modelID: z.string().optional(),
          model: z.object({ providerID: z.string(), modelID: z.string() }).optional(),
        })
        .optional(),
      parts: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    }),
  )
  .max(2)
const envelope = z.union([messages, z.object({ data: messages }).transform((value) => value.data)])

export async function captureTaskTerminalEvidence(
  session: string | undefined,
  client: {
    readonly session: {
      readonly messages: (input: {
        readonly path: { readonly id: string }
        readonly query?: { readonly limit: number }
        readonly signal?: AbortSignal
      }) => Promise<unknown>
    }
  },
): Promise<TaskTerminalEvidence> {
  // The V2 facade applies message limits after loading the full context; use the owner's receipt instead.
  if (!session || hasNativeSdkStorage(client)) return {}
  try {
    const raw = await runWithAbortBudget({
      timeoutMs: TERMINAL_EVIDENCE_TIMEOUT_MS,
      run: (signal) => client.session.messages({ path: { id: session }, query: { limit: 2 }, signal }),
    })
    const last = envelope.parse(raw).findLast((row) => row.info?.role === "assistant")
    if (!last) return {}
    const model =
      last.info?.model ??
      (last.info?.providerID && last.info.modelID
        ? { providerID: last.info.providerID, modelID: last.info.modelID }
        : undefined)
    return {
      producingModel: model ? `${model.providerID}/${model.modelID}` : undefined,
      output: last.parts
        ?.filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n")
        .slice(0, 8192),
    }
  } catch (error) {
    log("[background-agent] terminal evidence unavailable", { error: error instanceof Error ? error.name : "unknown" })
    return {}
  }
}
