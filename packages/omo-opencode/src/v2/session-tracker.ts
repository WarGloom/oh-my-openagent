import type { V2Event, V2SessionInfo } from "./context-types"

export type SessionTracker = {
  readonly seed: (sessions: ReadonlyArray<Pick<V2SessionInfo, "id" | "parentID" | "time">>) => void
  /** Feeds one host event; events it does not track, or that lack a session id, are ignored. */
  readonly observe: (event: V2Event) => void
  /** The 1.x `session.status()` map: only sessions that are not idle appear. */
  readonly statuses: () => Record<string, { type: "busy" }>
  readonly parentOf: (sessionID: string) => string | undefined
}

const EXECUTION_ENDED: ReadonlySet<string> = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

function sessionFields(event: V2Event): { sessionID: string; parentID?: string } | undefined {
  const { data } = event
  if (typeof data !== "object" || data === null) return undefined
  const { sessionID, parentID } = data as { sessionID?: unknown; parentID?: unknown }
  if (typeof sessionID !== "string") return undefined
  return typeof parentID === "string" ? { sessionID, parentID } : { sessionID }
}

export function createSessionTracker(): SessionTracker {
  const busy = new Set<string>()
  const parents = new Map<string, string>()
  const executionEvents = new Set<string>()
  const parentEvents = new Set<string>()

  return {
    seed(sessions) {
      for (const session of sessions) {
        if (
          !executionEvents.has(session.id) &&
          session.time.busy !== undefined &&
          session.time.busy > (session.time.idle ?? 0)
        )
          busy.add(session.id)
        if (!parentEvents.has(session.id) && session.parentID !== undefined) parents.set(session.id, session.parentID)
      }
    },
    observe(event) {
      const fields = sessionFields(event)
      if (fields === undefined) return
      if (event.type === "session.execution.started" || EXECUTION_ENDED.has(event.type)) {
        executionEvents.add(fields.sessionID)
        if (event.type === "session.execution.started") busy.add(fields.sessionID)
        else busy.delete(fields.sessionID)
      } else if (event.type === "session.created" && fields.parentID !== undefined) {
        parentEvents.add(fields.sessionID)
        parents.set(fields.sessionID, fields.parentID)
      } else if (event.type === "session.deleted") {
        executionEvents.add(fields.sessionID)
        parentEvents.add(fields.sessionID)
        busy.delete(fields.sessionID)
        parents.delete(fields.sessionID)
      }
    },
    statuses: () => Object.fromEntries([...busy].map((sessionID) => [sessionID, { type: "busy" as const }])),
    parentOf: (sessionID) => parents.get(sessionID),
  }
}
