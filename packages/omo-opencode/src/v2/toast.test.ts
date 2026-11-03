import { describe, expect, it, spyOn } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { createV2Setup } from "./create-v2-setup"
import { createFakePluginContext } from "./fake-plugin-context"
import tuiModule from "../tui"
import type { V2Toast } from "./toast-channel"
import * as config from "../config/validate"

describe("V2 toast delivery", () => {
  const setupV2Tui = tuiModule.setup
  function createTui() {
    const handlers = new Map<string, (event: { data: unknown }) => void>()
    const shown: V2Toast[] = []
    const context = {
      location: { directory: process.cwd() },
      data: { on: (type: string, callback: (event: { data: unknown }) => void) => {
        handlers.set(type, callback)
        return () => { handlers.delete(type) }
      } },
      ui: { toast: { show: (toast: V2Toast) => { shown.push(toast) } }, slot: () => () => {} },
    }
    return { context, shown, handlers }
  }

  it("#given two attached TUIs #when the facade shows a toast #then both receive every field and stop after disposal", async () => {
    // given
    const first = createTui()
    const second = createTui()
    const firstCleanup = await Reflect.apply(setupV2Tui, undefined, [first.context])
    const secondCleanup = await Reflect.apply(setupV2Tui, undefined, [second.context])
    const fake = createFakePluginContext()
    let registered = false
    let client: PluginInput["client"] | undefined
    const setup = createV2Setup({ serverPlugin: async (input) => { client = input.client; return {} } })
    const cleanup = await setup({ ...fake.context, rpc: { register: async (definition) => {
      registered = true
      return {
        dispose: async () => { registered = false },
        events: { emit: async (name, data) => {
          const parsed = definition.events[name].schema.parse(data)
          for (const tui of [first, second]) tui.handlers.get(`rpc.${definition.id}.${name}`)?.({ data: parsed })
        } },
      }
    } } })
    const body = { title: "Background task", message: "Task complete", variant: "success", duration: 4321 } as const
    try {
      // when
      const result = await client?.tui.showToast({ body })

      // then
      expect(result?.data).toBe(true)
      expect(first.shown).toEqual([body])
      expect(second.shown).toEqual([body])
      await firstCleanup()
      await secondCleanup()
      await cleanup()
      expect(registered).toBe(false)
      expect(first.handlers.size).toBe(0)
      expect(second.handlers.size).toBe(0)
    } finally {
      await firstCleanup()
      await secondCleanup()
      await cleanup()
    }
  })

  it("#given no TUI #when showToast runs before attachment #then it resolves without replaying old toasts", async () => {
    // given
    const fake = createFakePluginContext()
    let client: PluginInput["client"] | undefined
    const cleanup = await createV2Setup({ serverPlugin: async (input) => { client = input.client; return {} } })(fake.context)
    try {
      // when
      const result = await client?.tui.showToast({ body: { message: "No UI", variant: "info" } })
      const controller = new AbortController()
      const stream = fake.context.event.subscribe({ signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1000)]) })[Symbol.asyncIterator]()
      const next = stream.next()
      const latest = { message: "Attached", variant: "warning" } as const
      await client?.tui.showToast({ body: latest })

      // then
      expect(result?.data).toBe(true)
      expect(await next).toMatchObject({ value: { type: "rpc.omo.toast", data: latest } })
      controller.abort()
    } finally {
      await cleanup()
    }
  })

  it("#given an invalid toast event #when the TUI receives it #then it leaves the toast surface unchanged", async () => {
    // given
    const tui = createTui()
    const cleanup = await Reflect.apply(setupV2Tui, undefined, [tui.context])
    try {
      // when
      tui.handlers.get("rpc.omo.toast")?.({ data: { message: "Invalid", variant: "unknown" } })

      // then
      expect(tui.shown).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it("#given the sidebar is disabled #when a toast arrives #then it still shows and its subscription is disposed", async () => {
    // given
    const tui = createTui()
    const validated = config.validatePluginConfig(process.cwd())
    const validate = spyOn(config, "validatePluginConfig").mockReturnValue({
      ...validated, config: { tui: { sidebar: { enabled: false } } },
    })
    let cleanup: (() => void) | undefined
    const body = { message: "Sidebar disabled", variant: "info" } as const
    try {
      cleanup = await Reflect.apply(setupV2Tui, undefined, [tui.context])

      // when
      tui.handlers.get("rpc.omo.toast")?.({ data: body })

      // then
      expect(tui.shown).toEqual([body])
      cleanup?.()
      expect(tui.handlers.size).toBe(0)
    } finally {
      cleanup?.()
      validate.mockRestore()
    }
  })

  it("#given server startup fails #when setup rejects #then its toast registration is disposed", async () => {
    // given
    const fake = createFakePluginContext()
    let registered = false
    const failure = new Error("Plugin startup failed")
    const setup = createV2Setup({ serverPlugin: async () => { throw failure } })

    // when
    const result = setup({ ...fake.context, rpc: { register: async () => {
      registered = true
      return { dispose: async () => { registered = false }, events: { emit: async () => {} } }
    } } })

    // then
    await expect(result).rejects.toBe(failure)
    expect(registered).toBe(false)
  })
})
