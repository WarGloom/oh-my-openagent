import { expect, spyOn, test } from "bun:test"
import { createFakePluginContext } from "./fake-plugin-context"
import { registerNativeDashboard } from "./native-dashboard"

test("outside sessions never enter interest; deletion and disposal cancel queued changes", async () => {
  const fake = createFakePluginContext()
  const listeners = new Set<(id: string) => void>()
  const controller = new AbortController()
  const stream = fake.context.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]()
  const reset = stream.next()
  const lookup = fake.context.session.get
  const context = { ...fake.context, session: { ...fake.context.session, get: async ({ sessionID }: { sessionID: string }) => {
    const info = await lookup({ sessionID })
    return sessionID === "outside" ? { ...info, location: { directory: "/another/location" } } : info
  } } }
  const dashboard = await registerNativeDashboard(context, { backgroundManager: {
    getTasksByParentSession: () => [],
    onVisibleChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  } })
  const timer = spyOn(globalThis, "setTimeout")
  try {
    expect(await reset).toMatchObject({ value: { type: "rpc.omo.dashboard.changed", data: { revision: 1 } } })
    expect(await dashboard.get({ sessionID: "outside" })).toBeNull()
    for (const listener of listeners) listener("outside")
    expect(timer).toHaveBeenCalledTimes(0)
    expect(await dashboard.get({ sessionID: "local" })).toMatchObject({ sessionID: "local", revision: 1 })
    fake.emit({ type: "session.deleted", data: { sessionID: "local" } })
    await Promise.resolve()
    expect(await dashboard.get({ sessionID: "local" })).toBeNull()
    for (const listener of listeners) listener("local")
    expect(timer).toHaveBeenCalledTimes(0)
    await dashboard.get({ sessionID: "second" })
    for (const listener of listeners) listener("second")
    expect(timer).toHaveBeenCalledTimes(1)
    const late = [...listeners]
    await dashboard.dispose()
    for (const listener of late) listener("second")
    expect(listeners.size).toBe(0)
    expect(fake.activeSubscribers()).toBe(1)
    expect(timer).toHaveBeenCalledTimes(1)
    expect(await dashboard.get({ sessionID: "second" })).toBeNull()
  } finally {
    timer.mockRestore()
    await dashboard.dispose()
    controller.abort()
  }
})

test("dirty changes coalesce and changes during an in-flight flush reach a later revision", async () => {
  const fake = createFakePluginContext()
  const listeners = new Set<(id: string) => void>()
  const controller = new AbortController()
  const stream = fake.context.event.subscribe({ signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) })[Symbol.asyncIterator]()
  const reset = stream.next()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let hold = false
  const lookup = fake.context.session.get
  const context = { ...fake.context, session: { ...fake.context.session, get: async ({ sessionID }: { sessionID: string }) => {
    if (hold) { entered.resolve(); await release.promise }
    return lookup({ sessionID })
  } } }
  const dashboard = await registerNativeDashboard(context, { backgroundManager: {
    getTasksByParentSession: () => [],
    onVisibleChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  } })
  try {
    await reset
    await dashboard.get({ sessionID: "a" })
    await dashboard.get({ sessionID: "b" })
    hold = true
    const first = stream.next()
    for (let i = 0; i < 20; i += 1) for (const listener of listeners) listener(i % 2 === 0 ? "a" : "b")
    await entered.promise
    for (const listener of listeners) listener("a")
    hold = false
    release.resolve()
    expect(await first).toMatchObject({ value: { type: "rpc.omo.dashboard.changed", data: { revision: 2, sessionIDs: ["a", "b"] } } })
    expect(await stream.next()).toMatchObject({ value: { type: "rpc.omo.dashboard.changed", data: { revision: 3, sessionIDs: ["a"] } } })
  } finally {
    hold = false
    release.resolve()
    await dashboard.dispose()
    controller.abort()
  }
})

test("disposal during authoritative lookup suppresses emission and cannot restore interest", async () => {
  const fake = createFakePluginContext()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const lookup = fake.context.session.get
  const context = { ...fake.context, session: { ...fake.context.session, get: async ({ sessionID }: { sessionID: string }) => {
    entered.resolve()
    await release.promise
    return lookup({ sessionID })
  } } }
  const dashboard = await registerNativeDashboard(context)
  const pending = dashboard.get({ sessionID: "local" })
  await entered.promise
  await dashboard.dispose()
  release.resolve()
  expect(await pending).toBeNull()
  expect(fake.activeSubscribers()).toBe(0)
})
