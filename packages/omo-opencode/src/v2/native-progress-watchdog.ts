import type { V2Event, V2PluginContext } from "./context-types"
import { isRecord } from "../shared/record-type-guard"
import { log } from "../shared/logger"
import { recoverNativeFailure, recoveryMessageID } from "./native-recovery-state"

type Request = {
  readonly firstProgressMs: number
  progressed: boolean
  readonly waits: Map<string, "pending" | "settled">
  cancelled: boolean
  timer?: ReturnType<typeof setTimeout>
  hard?: ReturnType<typeof setTimeout>
  backoff?: ReturnType<typeof setTimeout>
}

const STALL_RESUME_TEXT =
  "The previous model request stalled and the progress watchdog interrupted it. Continue the task from the current state. Tool calls that already completed are in the transcript; do not repeat them unless a result is missing."

export function createNativeProgressWatchdog(deps: {
  readonly context: V2PluginContext
  readonly timeouts: { readonly firstProgressMs: number; readonly stallMs: number; readonly hardMs: number }
  /** A request stalled again after its one automatic resume. */
  readonly stalledAgain: (sessionID: string) => void
  readonly warn: (error: unknown) => void
}) {
  const requests = new Map<string, Request>()
  // One automatic resume per user turn: "pending" until the resumed run starts, then "used".
  const resumes = new Map<string, "pending" | "used" | "warned">()
  const recovering = new Map<
    string,
    {
      readonly request: Request
      readonly settled: ReturnType<typeof Promise.withResolvers<boolean>>
      readonly abort: AbortController
    }
  >()
  const interruptions = new Map<string, Promise<boolean>>()
  let disposed = false
  const clear = (sessionID: string) => {
    const request = requests.get(sessionID)
    clearTimeout(request?.timer)
    clearTimeout(request?.hard)
    clearTimeout(request?.backoff)
    requests.delete(sessionID)
  }
  const expire = async (sessionID: string, request: Request, timer: "first-progress" | "stall" | "hard") => {
    if (requests.get(sessionID) !== request || disposed) return
    clear(sessionID)
    log("[runtime-fallback] Native watchdog deadline expired", { sessionID, timer, progressed: request.progressed })
    if (resumes.has(sessionID)) {
      if (resumes.get(sessionID) !== "warned") {
        resumes.set(sessionID, "warned")
        deps.stalledAgain(sessionID)
      }
      return
    }
    const recovery = { request, settled: Promise.withResolvers<boolean>(), abort: new AbortController() }
    recovering.set(sessionID, recovery)
    // A stall carries no provider error, so it never selects another model: the resume keeps the session's model.
    interruptions.set(sessionID, recovery.settled.promise)
    let recovered = false
    let declineReason = "recovery did not commit a continuation"
    try {
      resumes.set(sessionID, "pending")
      recovered = await deps.context.experimental.session.recover(
        { sessionID },
        ({ boundaryID }) => recoverNativeFailure(sessionID, boundaryID, async () => {
          if (disposed || recovering.get(sessionID) !== recovery) {
            declineReason = "ownership lost during admission"
            return false
          }
          const outcome = await deps.context.experimental.session.continueAfterFailure({
            sessionID, boundaryID, id: recoveryMessageID(boundaryID), text: STALL_RESUME_TEXT,
          })
          if (outcome === "stale") declineReason = "continuation boundary stale"
          return outcome !== "stale"
        }),
        { signal: recovery.abort.signal },
      )
      if (!recovered) log("[runtime-fallback] Native watchdog recovery declined", { sessionID, reason: declineReason })
    } finally {
      if (!recovered && resumes.get(sessionID) === "pending") resumes.delete(sessionID)
      recovery.settled.resolve(recovered)
      if (!recovered && interruptions.get(sessionID) === recovery.settled.promise) interruptions.delete(sessionID)
      if (recovering.get(sessionID) === recovery) recovering.delete(sessionID)
    }
  }
  const arm = (sessionID: string, request: Request) => {
    clearTimeout(request.timer)
    if (request.cancelled || [...request.waits.values()].includes("pending")) return
    const timer = request.progressed ? "stall" : "first-progress"
    const ms = request.progressed ? deps.timeouts.stallMs : request.firstProgressMs
    if (ms > 0) request.timer = setTimeout(() => expire(sessionID, request, timer).catch(deps.warn), ms)
    if (deps.timeouts.hardMs > 0 && !request.hard) {
      request.hard = setTimeout(() => expire(sessionID, request, "hard").catch(deps.warn), deps.timeouts.hardMs)
    }
  }
  const pause = (request: Request) => {
    clearTimeout(request.timer)
    clearTimeout(request.hard)
    request.hard = undefined
  }
  return {
    defer(sessionID: string, delay: number) {
      const request = requests.get(sessionID)
      if (!request) return
      pause(request)
      clearTimeout(request.backoff)
      request.waits.set("provider:retry", "pending")
      const until = Date.now() + Math.max(0, delay)
      const resume = () => {
        const remaining = until - Date.now()
        if (remaining > 0) {
          request.backoff = setTimeout(resume, Math.min(remaining, 2_147_483_647))
          return
        }
        request.waits.delete("provider:retry")
        request.backoff = undefined
        arm(sessionID, request)
      }
      resume()
    },
    start(sessionID: string, firstProgressMs = deps.timeouts.firstProgressMs) {
      clear(sessionID)
      recovering.delete(sessionID)
      if (disposed || (firstProgressMs <= 0 && deps.timeouts.stallMs <= 0 && deps.timeouts.hardMs <= 0)) return
      const request: Request = { firstProgressMs, progressed: false, waits: new Map(), cancelled: false }
      requests.set(sessionID, request)
      arm(sessionID, request)
    },
    observe(event: V2Event) {
      const data = event.data
      if (!isRecord(data)) return
      const form = event.type === "form.created" && isRecord(data.form) ? data.form : undefined
      const sessionID = form?.sessionID ?? data.sessionID
      if (typeof sessionID !== "string") return
      const interruption = interruptions.get(sessionID)
      if (event.type === "session.execution.interrupted" && interruption) {
        interruptions.delete(sessionID)
        return interruption
      }
      if (event.type === "session.execution.started" || event.type === "session.deleted")
        interruptions.delete(sessionID)
      if (event.type === "session.deleted") recovering.delete(sessionID)
      if (event.type === "session.execution.started" && resumes.get(sessionID) === "pending")
        resumes.set(sessionID, "used")
      else if (
        event.type === "session.execution.started" ||
        event.type === "session.execution.succeeded" ||
        event.type === "session.deleted"
      )
        resumes.delete(sessionID)
      if (
        event.type.startsWith("session.execution.") ||
        event.type === "session.deleted" ||
        event.type === "session.step.ended" ||
        event.type === "session.step.failed" ||
        event.type === "session.compaction.started"
      ) {
        clear(sessionID)
        return
      }
      const request = requests.get(sessionID)
      if (!request) return
      if (event.type === "permission.asked" || event.type === "form.created") {
        const id = form?.id ?? data.id
        if (typeof id !== "string") return
        const key = `${form ? "form" : "permission"}:${id}`
        if (request.waits.has(key)) return
        request.waits.set(key, "pending")
        pause(request)
        return
      }
      if (event.type === "permission.replied" || event.type === "form.replied" || event.type === "form.cancelled") {
        const id = event.type === "permission.replied" ? data.requestID : data.id
        if (typeof id !== "string") return
        const key = `${event.type === "permission.replied" ? "permission" : "form"}:${id}`
        if (request.waits.get(key) !== "pending") return
        request.waits.set(key, "settled")
        if (event.type === "form.cancelled") {
          request.cancelled = true
          pause(request)
        } else arm(sessionID, request)
        return
      }
      if (
        event.type === "session.tool.called" ||
        event.type === "session.tool.success" ||
        event.type === "session.tool.failed"
      ) {
        // A running tool emits no model progress, so its run time is a wait and not a stall.
        request.progressed = true
        if (typeof data.id !== "string") return
        if (event.type === "session.tool.called" && data.executed === true) {
          arm(sessionID, request)
          return
        }
        if (event.type === "session.tool.called") {
          request.waits.set(`tool:${data.id}`, "pending")
          pause(request)
          return
        }
        request.waits.set(`tool:${data.id}`, "settled")
        arm(sessionID, request)
        return
      }
      if (
        event.type.startsWith("session.text.") ||
        event.type.startsWith("session.reasoning.") ||
        event.type.startsWith("session.tool.") ||
        event.type === "session.step.streamed"
      ) {
        request.progressed = true
        arm(sessionID, request)
      }
    },
    dispose() {
      disposed = true
      for (const sessionID of requests.keys()) clear(sessionID)
      for (const recovery of recovering.values()) recovery.abort.abort()
      recovering.clear()
      interruptions.clear()
      resumes.clear()
    },
  }
}
