import { expect, test } from "bun:test"
import { createFakePluginContext } from "../fake-plugin-context"
import { installConfigBridge } from "./install-config-bridge"

test("refreshes and resubscribes after a stream failure, then disposes the replacement subscription", async () => {
  const fake = createFakePluginContext()
  const subscribed = Promise.withResolvers<void>()
  const refreshed = Promise.withResolvers<void>()
  const ended = Promise.withResolvers<void>()
  let subscriptions = 0
  let runs = 0
  const warnings: string[] = []
  const context = {
    ...fake.context,
    event: {
      subscribe: async function* (options?: { signal?: AbortSignal }) {
        subscriptions += 1
        if (subscriptions === 1) throw new Error("broken stream")
        subscribed.resolve()
        try {
          for await (const event of fake.context.event.subscribe(options)) yield event
        } finally {
          ended.resolve()
        }
      },
    },
  }
  const dispose = await installConfigBridge(
    context,
    async (config) => {
      runs += 1
      config.agent = { worker: { model: `p/model-${runs}` } }
      if (runs === 3) refreshed.resolve()
    },
    { warn: (message) => warnings.push(message), debounceMs: 0 },
  )
  try {
    await subscribed.promise
    fake.emit({ type: "model.updated" })
    await refreshed.promise
    expect(subscriptions).toBe(2)
    expect(runs).toBe(3)
    expect(warnings).toEqual(["event subscription failed: broken stream"])
    await dispose()
    await ended.promise
    expect(fake.activeSubscribers()).toBe(0)
  } finally {
    await dispose()
  }
})
