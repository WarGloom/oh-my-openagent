import { describe, expect, it } from "bun:test"
import { createDashboardClient, type NativeDashboardState } from "./dashboard-client"
import type { DashboardSnapshot } from "./dashboard-channel"

function snapshot(sessionID: string): DashboardSnapshot {
  return {
    sessionID,
    revision: 1,
    activity: { agents: [], loop: null },
    teams: [],
    tasks: { counts: { pending: 0, running: 0, completed: 0, error: 0, cancelled: 0, interrupt: 0 }, rows: [] },
    monitors: { counts: { starting: 0, running: 0, exited: 0, stopped: 0, failed: 0 }, rows: [] },
  }
}

function fixture() {
  type Event = {
    readonly location: { readonly directory: string }
    readonly data: { readonly sessionIDs?: string[]; readonly sessionID?: string; readonly revision?: number }
  }
  const handlers = new Map<string, (event: Event) => void>()
  const requests: {
    readonly sessionID: string
    readonly directory: string
    readonly reply: ReturnType<typeof Promise.withResolvers<DashboardSnapshot | null>>
  }[] = []
  const states: (NativeDashboardState | null)[] = []
  const order: string[] = []
  const on = (type: string, callback: (event: Event) => void) => {
    order.push(type)
    handlers.set(type, callback)
    return () => {
      handlers.delete(type)
    }
  }
  const context = {
    client: {
      rpc: () => ({
        events: { on },
        get: (
          input: { readonly sessionID: string },
          options: { readonly location: { readonly directory: string } },
        ) => {
          order.push("get")
          const reply = Promise.withResolvers<DashboardSnapshot | null>()
          requests.push({ sessionID: input.sessionID, directory: options.location.directory, reply })
          return reply.promise
        },
      }),
    },
    data: {
      on,
      session: {
        get: (id: string) =>
          id === "missing" ? undefined : { location: { directory: id === "b" ? "/project-b" : "/project-a" } },
      },
    },
  }
  const client: ReturnType<typeof createDashboardClient> = Reflect.apply(createDashboardClient, undefined, [
    context,
    (state: NativeDashboardState | null) => states.push(state),
  ])
  const changed = (directory: string, sessionIDs?: string[]) =>
    handlers.get("changed")?.({
      location: { directory },
      data: { revision: 0, ...(sessionIDs === undefined ? {} : { sessionIDs }) },
    })
  return { client, states, requests, handlers, order, changed }
}

describe("native dashboard RPC consumer", () => {
  it("subscribes first and accepts only the selected location and relevant invalidations including reset", async () => {
    const f = fixture()
    try {
      const initial = f.client.select("a")
      expect(f.order.indexOf("changed")).toBeLessThan(f.order.indexOf("get"))
      expect(f.requests[0]?.directory).toBe("/project-a")
      f.requests[0]?.reply.resolve(snapshot("a"))
      await initial
      f.changed("/project-b", ["a"])
      f.changed("/project-a", ["other"])
      f.changed("/project-a", [])
      expect(f.requests).toHaveLength(1)
      f.changed("/project-a", ["a"])
      expect(f.requests).toHaveLength(2)
      f.requests[1]?.reply.resolve(snapshot("a"))
      await f.requests[1]?.reply.promise
      f.changed("/project-a")
      expect(f.requests).toHaveLength(3)
      f.requests[2]?.reply.resolve(null)
      await f.requests[2]?.reply.promise
      expect(f.states.at(-1)).toBeNull()
    } finally {
      f.client.dispose()
    }
  })

  it("keeps the newest invalidation and rejects stale responses after rapid navigation and reconnect", async () => {
    const f = fixture()
    try {
      const first = f.client.select("a")
      f.changed("/project-a", ["a"])
      expect(f.requests).toHaveLength(2)
      const next = f.client.select("b")
      expect(f.states.at(-1)).toEqual({ kind: "loading" })
      f.requests[2]?.reply.resolve(snapshot("b"))
      await next
      f.requests[1]?.reply.resolve(snapshot("a"))
      await f.requests[1]?.reply.promise
      f.requests[0]?.reply.resolve(snapshot("a"))
      await first
      expect(f.states.at(-1)).toEqual({ kind: "ready", snapshot: snapshot("b") })
      f.handlers.get("server.connected")?.({ location: { directory: "/unrelated-global-feed" }, data: {} })
      expect(f.requests[3]?.directory).toBe("/project-b")
      f.requests[3]?.reply.resolve(null)
      await f.requests[3]?.reply.promise
      expect(f.states.at(-1)).toBeNull()
    } finally {
      f.client.dispose()
    }
  })

  it("uses generic errors, clears missing metadata and ignores work after disposal", async () => {
    const f = fixture()
    const request = f.client.select("a")
    f.requests[0]?.reply.reject(new Error("private backend payload"))
    await request
    expect(f.states.at(-1)).toEqual({ kind: "error", message: "Connection failed" })
    await f.client.select("missing")
    expect(f.states.at(-1)).toBeNull()
    expect(f.requests).toHaveLength(1)
    const pending = f.client.select("b")
    f.client.dispose()
    const before = f.states.length
    f.requests[1]?.reply.resolve(snapshot("b"))
    await pending
    expect(f.states).toHaveLength(before)
    expect(f.handlers.size).toBe(0)
  })

  it("clears a deleted selected session before its pending reply can restore it", async () => {
    const f = fixture()
    try {
      const pending = f.client.select("a")
      f.handlers.get("session.deleted")?.({ location: { directory: "/project-a" }, data: { sessionID: "a" } })
      f.requests[0]?.reply.resolve(snapshot("a"))
      await pending
      expect(f.states.at(-1)).toBeNull()
    } finally {
      f.client.dispose()
    }
  })
})
