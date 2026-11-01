import { expect, it } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import type { MonitorCounters, MonitorManager, MonitorRecord } from "../features/monitor/types"
import { createMonitorStatusInjectorHook } from "../hooks/monitor-status-injector/hook"
import { createMessagesTransformHandler } from "../plugin/messages-transform"
import { createFakePluginContext } from "./fake-plugin-context"
import { installSessionHooks } from "./session-hooks"

it("#given a V2 monitor #when it starts and stops #then the instruction entry replaces bridge injection", async () => {
  // given
  const counters: MonitorCounters = { totalLines: 0, matchedLines: 0, unmatchedLines: 0, droppedMatched: 0, droppedUnmatched: 0, bytesDropped: 0, lastSequence: 0 }
  const record: MonitorRecord = { id: "mon_1", command: "watch", label: "watch", mode: "idle", parentSessionId: "ses_1", startedAt: new Date(0), status: "running", counters }
  let active = true
  const manager: MonitorManager = {
    start: async () => record, stop: async () => {}, list: () => active ? [record] : [], get: () => record,
    getOutput: () => ({ lines: [], counters }), stopSessionMonitors: async () => {}, handleEvent: () => {}, shutdown: async () => {},
  }
  const fake = createFakePluginContext()
  const calls: Array<{ action: string; sessionID: string; key: string; value?: string }> = []
  const context = { ...fake.context, session: { ...fake.context.session, instructions: { entry: {
    put: async (input: { sessionID: string; key: string; value: string }) => { calls.push({ action: "put", ...input }) },
    remove: async (input: { sessionID: string; key: string }) => { calls.push({ action: "remove", ...input }) },
  } } } }
  const hook = createMonitorStatusInjectorHook(manager, { enabled: true })
  const transform = createMessagesTransformHandler({ hooks: { monitorStatusInjector: hook } })
  const cleanup = await installSessionHooks(context, { "experimental.chat.messages.transform": transform } as Hooks, { warn: () => {} })
  try {
    // when
    const event = await fake.triggerContext({ sessionID: "ses_1", agent: "sisyphus", model: { providerID: "openai", id: "gpt-test" }, system: [], messages: [{ id: "msg_1", role: "user", content: [{ type: "text", text: "go" }] }], options: {} })
    active = false
    await fake.triggerToolAfter({ tool: "monitor_stop", sessionID: "ses_1", agent: "sisyphus", messageID: "msg_1", id: "call_1", input: {}, status: "completed", result: {} })
    // then
    expect(event.messages).toHaveLength(1)
    expect(calls.map(({ action, sessionID, key }) => ({ action, sessionID, key }))).toEqual([
      { action: "put", sessionID: "ses_1", key: "omo.monitor-status" },
      { action: "remove", sessionID: "ses_1", key: "omo.monitor-status" },
    ])
    expect(calls[0]?.value).toBe("Active monitors: mon_1 (watch, running, 0 matched) - call monitor_stop to stop")
  } finally {
    await cleanup()
  }
})

it("#given a long monitor label #when V2 refreshes status #then the host accepts its JSON-encoded value", async () => {
  // given
  const counters: MonitorCounters = { totalLines: 0, matchedLines: 0, unmatchedLines: 0, droppedMatched: 0, droppedUnmatched: 0, bytesDropped: 0, lastSequence: 0 }
  const record: MonitorRecord = { id: "mon_1", command: "watch", label: '😀"\\\n'.repeat(100_000), mode: "idle", parentSessionId: "ses_1", startedAt: new Date(0), status: "running", counters }
  const manager: MonitorManager = {
    start: async () => record, stop: async () => {}, list: () => [record], get: () => record,
    getOutput: () => ({ lines: [], counters }), stopSessionMonitors: async () => {}, handleEvent: () => {}, shutdown: async () => {},
  }
  const fake = createFakePluginContext()
  const values: string[] = []
  const context = { ...fake.context, session: { ...fake.context.session, instructions: { entry: {
    put: async (input: { sessionID: string; key: string; value: string }) => {
      if (Buffer.byteLength(JSON.stringify(input.value), "utf8") > 256 * 1024) throw new Error("value too large")
      values.push(input.value)
    },
    remove: async () => {},
  } } } }
  const hook = createMonitorStatusInjectorHook(manager, { enabled: true })
  const transform = createMessagesTransformHandler({ hooks: { monitorStatusInjector: hook } })
  const cleanup = await installSessionHooks(context, { "experimental.chat.messages.transform": transform } as Hooks, { warn: () => {} })
  try {
    // when
    await fake.triggerContext({ sessionID: "ses_1", agent: "sisyphus", model: { providerID: "openai", id: "test" }, system: [], messages: [], options: {} })
    // then
    expect(values).toHaveLength(1)
    expect(Buffer.byteLength(JSON.stringify(values[0]), "utf8")).toBeLessThanOrEqual(256 * 1024)
    expect(values[0]).toContain("mon_1")
    expect(values[0]).toContain("monitor_stop")
    expect(values[0]).not.toContain("\ufffd")
  } finally {
    await cleanup()
  }
})
