import type { V2Event, V2ModelRef, V2PluginContext } from "./context-types"
import { isRecord } from "../shared/record-type-guard"

type Request = {
  readonly agent: string
  readonly model: V2ModelRef
  progressed: boolean
  unsafe: boolean
  waiting: boolean
  timer?: ReturnType<typeof setTimeout>
  hard?: ReturnType<typeof setTimeout>
}

export function createNativeProgressWatchdog(deps: {
  readonly context: V2PluginContext
  readonly timeouts: { readonly firstProgressMs: number; readonly stallMs: number; readonly hardMs: number }
  readonly recover: (sessionID: string, request: { readonly agent: string; readonly model: V2ModelRef }, current: () => boolean) => Promise<boolean>
  readonly warn: (error: unknown) => void
}) {
  const requests = new Map<string, Request>()
  const recovering = new Map<string, { readonly request: Request; readonly settled: ReturnType<typeof Promise.withResolvers<boolean>> }>()
  const interruptions = new Map<string, Promise<boolean>>()
  let disposed = false
  const clear = (sessionID: string) => {
    const request = requests.get(sessionID)
    clearTimeout(request?.timer)
    clearTimeout(request?.hard)
    requests.delete(sessionID)
  }
  const expire = async (sessionID: string, request: Request) => {
    if (requests.get(sessionID) !== request || disposed) return
    clear(sessionID)
    const recovery = { request, settled: Promise.withResolvers<boolean>() }
    recovering.set(sessionID, recovery)
    if (!request.unsafe) interruptions.set(sessionID, recovery.settled.promise)
    let recovered = false
    try {
      await deps.context.session.interrupt({ sessionID, resume: false })
      if (!request.unsafe && !disposed && recovering.get(sessionID) === recovery) {
        recovered = await deps.recover(sessionID, request, () => !disposed && recovering.get(sessionID) === recovery)
      }
    } finally {
      recovery.settled.resolve(recovered)
      if (!recovered && interruptions.get(sessionID) === recovery.settled.promise) interruptions.delete(sessionID)
      if (recovering.get(sessionID) === recovery) recovering.delete(sessionID)
    }
  }
  const arm = (sessionID: string, request: Request) => {
    clearTimeout(request.timer)
    if (request.waiting) return
    const ms = request.progressed ? deps.timeouts.stallMs : deps.timeouts.firstProgressMs
    if (ms > 0) request.timer = setTimeout(() => expire(sessionID, request).catch(deps.warn), ms)
    if (deps.timeouts.hardMs > 0 && !request.hard) {
      request.hard = setTimeout(() => expire(sessionID, request).catch(deps.warn), deps.timeouts.hardMs)
    }
  }
  return {
    start(sessionID: string, agent: string, model: V2ModelRef) {
      clear(sessionID)
      recovering.delete(sessionID)
      if (disposed || !Object.values(deps.timeouts).some((value) => value > 0)) return
      const request: Request = { agent, model, progressed: false, unsafe: false, waiting: false }
      requests.set(sessionID, request)
      arm(sessionID, request)
    },
    observe(event: V2Event) {
      const data = event.data
      if (!isRecord(data) || typeof data.sessionID !== "string") return
      const sessionID = data.sessionID
      const interruption = interruptions.get(sessionID)
      if (event.type === "session.execution.interrupted" && interruption) {
        interruptions.delete(sessionID)
        return interruption
      }
      if (event.type === "session.execution.started" || event.type === "session.deleted") interruptions.delete(sessionID)
      if (event.type === "session.deleted") recovering.delete(sessionID)
      if (event.type.startsWith("session.execution.") || event.type === "session.deleted" || event.type === "session.step.ended" || event.type === "session.step.failed" || event.type === "session.compaction.started") {
        clear(sessionID)
        return
      }
      const request = requests.get(sessionID)
      if (!request) return
      if (event.type === "permission.asked") {
        request.waiting = true
        clearTimeout(request.timer)
        clearTimeout(request.hard)
        request.hard = undefined
        return
      }
      if (event.type === "permission.replied") {
        request.waiting = false
        arm(sessionID, request)
        return
      }
      if (event.type.startsWith("session.tool.")) request.unsafe = true
      if (event.type.startsWith("session.text.") || event.type.startsWith("session.reasoning.") || event.type.startsWith("session.tool.") || event.type === "session.step.streamed") {
        request.progressed = true
        arm(sessionID, request)
      }
    },
    dispose() {
      disposed = true
      for (const sessionID of requests.keys()) clear(sessionID)
      recovering.clear()
      interruptions.clear()
    },
  }
}
