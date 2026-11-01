import { describe, expect, it } from "bun:test"
import { createSessionTracker } from "./session-tracker"

const event = (type: string, data: Record<string, unknown>) => ({ type, data })

describe("createSessionTracker", () => {
  it("#given sessions already running at setup #when seeding native session timestamps #then busy state and parent links survive reload", () => {
    // given
    const tracker = createSessionTracker()
    // when
    tracker.seed([
      { id: "running", parentID: "parent", time: { created: 1, updated: 4, busy: 4, idle: 3 } },
      { id: "idle", time: { created: 1, updated: 4, busy: 2, idle: 4 } },
      { id: "never-started", time: { created: 1, updated: 1 } },
    ])
    // then
    expect(tracker.statuses()).toEqual({ running: { type: "busy" } })
    expect(tracker.parentOf("running")).toBe("parent")
  })

  it("#given execution events during setup #when a stale native snapshot arrives #then it cannot resurrect ended sessions or clear new activity", () => {
    // given
    const tracker = createSessionTracker()
    tracker.observe(event("session.execution.succeeded", { sessionID: "ended" }))
    tracker.observe(event("session.execution.started", { sessionID: "running" }))
    tracker.observe(event("session.deleted", { sessionID: "deleted" }))
    // when
    tracker.seed([
      { id: "ended", time: { created: 1, updated: 3, busy: 3 } },
      { id: "running", time: { created: 1, updated: 3, idle: 3 } },
      { id: "deleted", parentID: "parent", time: { created: 1, updated: 3, busy: 3 } },
    ])
    // then
    expect(tracker.statuses()).toEqual({ running: { type: "busy" } })
    expect(tracker.parentOf("deleted")).toBeUndefined()
  })

  describe("#given execution events", () => {
    it("#when a session starts executing #then it reports busy until the execution ends", () => {
      // given
      const tracker = createSessionTracker()

      // when
      tracker.observe(event("session.execution.started", { sessionID: "ses_1" }))

      // then
      expect(tracker.statuses()).toEqual({ ses_1: { type: "busy" } })

      // when
      tracker.observe(event("session.execution.succeeded", { sessionID: "ses_1" }))

      // then
      expect(tracker.statuses()).toEqual({})
    })

    it("#when an execution fails or is interrupted #then the session is no longer busy", () => {
      // given
      const tracker = createSessionTracker()
      tracker.observe(event("session.execution.started", { sessionID: "ses_1" }))
      tracker.observe(event("session.execution.started", { sessionID: "ses_2" }))

      // when
      tracker.observe(event("session.execution.failed", { sessionID: "ses_1" }))
      tracker.observe(event("session.execution.interrupted", { sessionID: "ses_2", reason: "user" }))

      // then
      expect(tracker.statuses()).toEqual({})
    })
  })

  describe("#given session lifecycle events", () => {
    it("#when a child session is created #then its parent is known until it is deleted", () => {
      // given
      const tracker = createSessionTracker()

      // when
      tracker.observe(event("session.created", { sessionID: "ses_child", parentID: "ses_parent" }))

      // then
      expect(tracker.parentOf("ses_child")).toBe("ses_parent")
      expect(tracker.parentOf("ses_parent")).toBeUndefined()

      // when
      tracker.observe(event("session.deleted", { sessionID: "ses_child" }))

      // then
      expect(tracker.parentOf("ses_child")).toBeUndefined()
    })

    it("#when a busy session is deleted #then it stops being reported busy", () => {
      // given
      const tracker = createSessionTracker()
      tracker.observe(event("session.execution.started", { sessionID: "ses_1" }))

      // when
      tracker.observe(event("session.deleted", { sessionID: "ses_1" }))

      // then
      expect(tracker.statuses()).toEqual({})
    })
  })

  describe("#given events it does not track", () => {
    it("#when unrelated or malformed events arrive #then nothing changes and nothing throws", () => {
      // given
      const tracker = createSessionTracker()

      // when
      tracker.observe({ type: "session.text.delta" })
      tracker.observe({ type: "session.execution.started" })
      tracker.observe({ type: "session.execution.started", data: "nope" })
      tracker.observe({ type: "session.execution.started", data: { sessionID: 7 } })

      // then
      expect(tracker.statuses()).toEqual({})
    })
  })
})
