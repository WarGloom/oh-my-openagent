import { expect, test } from "bun:test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { MonitorManager } from "./manager"

test("monitor processes use isolated session snapshots and inherit only when a snapshot is absent", async () => {
  // given
  const environments: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    sessionA: { GH_CONFIG_DIR: "/offline/monitor-a", OMO_MONITOR_HOME: "a" },
    sessionB: { GH_CONFIG_DIR: "/offline/monitor-b", OMO_MONITOR_HOME: "b" },
  }
  const outputs = new Map<string, ReturnType<typeof Promise.withResolvers<string>>>()
  for (const id of ["sessionA", "sessionB", "sessionInherited"]) outputs.set(id, Promise.withResolvers<string>())
  const manager = new MonitorManager({
    pluginContext: unsafeTestValue({ client: {}, directory: "/" }),
    environment: async (sessionID) => environments[sessionID],
    config: { batch_max_lines: 1 },
    deps: {
      registerManagerForCleanup: () => {},
      unregisterManagerForCleanup: () => {},
      createInjector: (record) => ({
        queueBatch: (_record, batch) => {
          const line = batch.lines.find((line) => line.stream === "stdout")
          if (line) outputs.get(record.parentSessionId)?.resolve(line.text)
        },
        flushMonitor: async () => {},
      }),
    },
  })
  const signal = AbortSignal.timeout(5_000)
  const timedOut = new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("Monitor output did not arrive")), { once: true })
  })
  try {
    // when
    const results = await Promise.all([...outputs].map(async ([sessionID, output]) => {
      const script = sessionID === "sessionInherited"
        ? `console.log(JSON.stringify({ inherited: process.env.HOME === ${JSON.stringify(process.env.HOME)} }))`
        : "console.log(JSON.stringify({ marker: process.env.GH_CONFIG_DIR, home: process.env.OMO_MONITOR_HOME, hasPath: process.env.PATH !== undefined }))"
      await manager.start({ parentSessionId: sessionID, command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}` })
      return JSON.parse(await Promise.race([output.promise, timedOut]))
    }))

    // then
    expect(results).toEqual([
      { marker: "/offline/monitor-a", home: "a", hasPath: false },
      { marker: "/offline/monitor-b", home: "b", hasPath: false },
      { inherited: true },
    ])
  } finally {
    await manager.shutdown()
  }
})
