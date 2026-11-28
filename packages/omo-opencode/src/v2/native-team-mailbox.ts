import type { V2MailboxAdmission, V2MailboxDelivery } from "@oh-my-opencode/team-core/team-mailbox/v2-delivery"
import type { TeamMailboxInjectorHook } from "../hooks/team-mailbox-injector/hook"
import { log } from "../shared/logger"
import { nativeAdmissionErrorFields } from "../shared/native-admission-error-fields"
import type { V2PluginContext, V2Registration } from "./context-types"
import { admitNativeTeamMessage } from "./native-team-jobs"
import { lookupTeamSession } from "../features/team-mode/team-session-registry"

type MailboxConsumer = (admit: (message: V2MailboxAdmission) => Promise<void | false>) => Promise<V2MailboxDelivery>
type MailboxSource = "live" | "idle" | "context"
type MailboxAttempt = {
  readonly sessionID: string
  readonly source: MailboxSource
  readonly identity?: { readonly teamRunId: string; readonly memberName: string }
  readonly consume: MailboxConsumer
}
type MailboxRetry = { readonly context: V2PluginContext; readonly timer: ReturnType<typeof setTimeout> }

const RETRY_MIN_MS = 250
const RETRY_MAX_MS = 30_000
const pending = new Map<string, MailboxRetry>()
const disposed = new WeakSet<V2PluginContext>()

export function stopNativeTeamMailbox(context: V2PluginContext): void {
  disposed.add(context)
  for (const [sessionID, retry] of pending) {
    if (retry.context !== context) continue
    clearTimeout(retry.timer)
    pending.delete(sessionID)
  }
}

export async function deliverNativeTeamMailbox(
  context: V2PluginContext,
  input: MailboxAttempt,
  retryMs = RETRY_MIN_MS,
): Promise<readonly string[]> {
  const { sessionID, source, consume } = input
  if (disposed.has(context)) return []

  const failed = (error: unknown) => {
    const message = source === "idle" ? "team idle wake hint failed" : "[team-mailbox] V2 live delivery failed"
    log(message, { sessionID, source, ...input.identity, ...nativeAdmissionErrorFields(error) })
  }
  let result: V2MailboxDelivery
  try {
    result = await consume(async (message) => {
      if (disposed.has(context)) return false
      try {
        const member = input.identity ?? lookupTeamSession(sessionID)
        if (!member) throw new Error("Native team delivery requires registered membership")
        return await admitNativeTeamMessage(context, message, member)
      } catch (error) {
        failed(error)
        return false
      }
    })
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    failed(error)
    result = { admitted: [], deferred: true }
  }

  if (result.deferred && !disposed.has(context) && !pending.has(sessionID)) {
    const timer = setTimeout(() => {
      pending.delete(sessionID)
      void deliverNativeTeamMailbox(context, input, Math.min(retryMs * 2, RETRY_MAX_MS))
    }, retryMs)
    timer.unref()
    pending.set(sessionID, { context, timer })
  }
  return result.admitted
}

export async function registerNativeTeamMailbox(
  context: V2PluginContext,
  hook: TeamMailboxInjectorHook,
): Promise<V2Registration> {
  return context.session.hook("context", async (event) => {
    await deliverNativeTeamMailbox(context, {
      sessionID: event.sessionID,
      source: "context",
      consume: (admit) => hook.nativeDeliver(event.sessionID, admit),
    })
  })
}
