import { describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import type { Hooks } from "@opencode-ai/plugin"
import { createFakePluginContext } from "./fake-plugin-context"
import type { V2ModelInfo, V2ToolBeforeEvent } from "./context-types"
import { bindAgentModelOverrides } from "./native-subagent-model"
import { installHooks } from "./install-hooks"
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validatePluginConfig } from "../config/validate"
import { createModelConfigReload } from "./model-config-reload"
import { watchModelConfigFiles } from "./model-config-watch"

const primary = "anthropic/claude-haiku-5-5"
const agent = "pinion-rust-dev-light"
const hostModel: V2ModelInfo = {
  id: "haiku",
  modelID: "claude-haiku-5-5",
  providerID: "anthropic",
  name: "Haiku",
  status: "active",
  enabled: true,
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [{ id: "xhigh" }],
  limit: { context: 200_000, output: 8_000 },
}

describe("V2 native subagent OMO model overrides", () => {
  test.each(["unknown-key", "pruned-value"])(
    "gate repair: reloads with an unchanged activation %s diagnostic",
    (kind) => {
      // given
      const directory = mkdtempSync(join(process.env.HOME ?? tmpdir(), "omo-baseline-"))
      mkdirSync(join(directory, ".omo"))
      const path = join(directory, ".omo/omo.jsonc")
      const configFor = (model: string) => ({
        agents: { [agent]: { model, ...(kind === "pruned-value" ? { temperature: 99 } : {}) } },
        ...(kind === "unknown-key" ? { unrelated_unknown_key: true } : {}),
      })
      writeFileSync(path, JSON.stringify(configFor(primary)))
      const activation = validatePluginConfig(directory)
      const warnings: string[] = []
      const reload = createModelConfigReload({
        directory,
        config: activation.config,
        activation,
        load: validatePluginConfig,
        report: (message) => warnings.push(message),
      })
      try {
        // when
        writeFileSync(path, JSON.stringify(configFor("openai/gpt-6-luna")))
        reload.reload()
        // then
        expect(activation.config.agents?.[agent]?.model).toBe("openai/gpt-6-luna")
        expect(warnings.length).toBe(1)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )

  test.each([true, false])("gate repair: publishes the new primary entry tuning, provided=%s", (tuned) => {
    // given
    const directory = mkdtempSync(join(process.env.HOME ?? tmpdir(), "omo-primary-"))
    mkdirSync(join(directory, ".omo"))
    const path = join(directory, ".omo/omo.jsonc")
    writeFileSync(
      path,
      JSON.stringify({ agents: { [agent]: { models: [{ model: primary, reasoning: "low", temperature: 0.2 }] } } }),
    )
    const activation = validatePluginConfig(directory)
    const reload = createModelConfigReload({
      directory,
      config: activation.config,
      activation,
      load: validatePluginConfig,
      report: () => {},
    })
    const settings = tuned ? { reasoning: "high", temperature: 0.8 } : {}
    try {
      // when
      writeFileSync(
        path,
        JSON.stringify({ agents: { [agent]: { models: [{ model: "openai/gpt-6-luna", ...settings }] } } }),
      )
      reload.reload()
      // then
      const selected = activation.config.agents?.[agent]
      expect({ model: selected?.model, reasoning: selected?.reasoning, temperature: selected?.temperature }).toEqual({
        model: "openai/gpt-6-luna",
        reasoning: tuned ? "high" : undefined,
        temperature: tuned ? 0.8 : undefined,
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("gate repair: excludes names absent from the activation view", () => {
    // given
    const directory = mkdtempSync(join(process.env.HOME ?? tmpdir(), "omo-names-"))
    mkdirSync(join(directory, ".omo"))
    const path = join(directory, ".omo/omo.jsonc")
    writeFileSync(path, JSON.stringify({ agents: { [agent]: { model: primary } } }))
    const activation = validatePluginConfig(directory)
    const reload = createModelConfigReload({
      directory,
      config: activation.config,
      activation,
      load: validatePluginConfig,
      report: () => {},
    })
    try {
      // when
      writeFileSync(
        path,
        JSON.stringify({
          agents: { [agent]: { model: primary }, newcomer: { model: primary, prompt: "new" } },
          categories: { newcomer: { model: primary, description: "new" } },
        }),
      )
      reload.reload()
      // then
      expect(activation.config.agents?.newcomer).toBeUndefined()
      expect(activation.config.categories?.newcomer).toBeUndefined()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test.each(["recreate", "new-layer"])("gate repair: watches project layer %s events", async (kind) => {
    // given
    const root = mkdtempSync(join(process.env.HOME ?? tmpdir(), "omo-walked-"))
    const directory = join(root, "project")
    mkdirSync(directory)
    const omo = join(directory, ".omo")
    const path = join(omo, "omo.jsonc")
    if (kind === "recreate") {
      mkdirSync(omo)
      writeFileSync(path, JSON.stringify({ agents: { [agent]: { model: primary } } }))
    }
    let observed: (() => void) | undefined
    const stop = watchModelConfigFiles({ directory, report: () => {}, notify: () => observed?.() })
    const changed = (action: () => void, expected: string | undefined) =>
      new Promise<void>((resolve, reject) => {
        const signal = AbortSignal.timeout(1000)
        const timeout = () => reject(new Error(`Missing ${kind} watcher notification for ${expected}`))
        signal.addEventListener("abort", timeout, { once: true })
        observed = () => {
          if (validatePluginConfig(directory).config.agents?.[agent]?.model !== expected) return
          signal.removeEventListener("abort", timeout)
          resolve()
        }
        action()
      })
    try {
      // when
      if (kind === "recreate") await changed(() => rmSync(omo, { recursive: true }), undefined)
      await changed(() => {
        mkdirSync(omo)
        writeFileSync(path, JSON.stringify({ agents: { [agent]: { model: "openai/gpt-6-luna" } } }))
      }, "openai/gpt-6-luna")
      // then
      expect(validatePluginConfig(directory).config.agents?.[agent]?.model).toBe("openai/gpt-6-luna")
    } finally {
      stop()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test.each(["synchronous", "event"])(
    "gate repair: contains %s watcher failures and retires errored handles",
    (kind) => {
      // given
      const directory = mkdtempSync(join(process.env.HOME ?? tmpdir(), "omo-watch-error-"))
      mkdirSync(join(directory, ".omo"))
      writeFileSync(join(directory, ".omo/omo.jsonc"), "{}")
      const watch = spyOn(fs, "watch")
      const reports: string[] = []
      let stop: (() => void) | undefined
      try {
        if (kind === "synchronous")
          watch.mockImplementationOnce(() => {
            throw Object.assign(new Error("watch limit"), { code: "ENOSPC" })
          })
        // when
        stop = watchModelConfigFiles({ directory, notify: () => {}, report: (message) => reports.push(message) })
        if (kind === "event") {
          const index = watch.mock.calls.findIndex(([path]) => path === join(directory, ".omo"))
          const result = watch.mock.results[index]
          if (!result || result.type !== "return") throw new Error("Project watcher was not installed")
          const close = spyOn(result.value, "close")
          result.value.emit("error", new Error("watch handle failed"))
          // then
          expect(close).toHaveBeenCalledTimes(1)
          expect(watch.mock.calls.filter(([path]) => path === join(directory, ".omo"))).toHaveLength(2)
        }
        expect(reports).toHaveLength(1)
      } finally {
        stop?.()
        watch.mockRestore()
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )

  test("reloads layered models after atomic edits, rejects invalid edits and freezes non-model settings", async () => {
    // given
    const directory = mkdtempSync(join(process.env.HOME ?? tmpdir(), "omo-model-reload-"))
    mkdirSync(join(directory, ".omo"))
    const path = join(directory, ".omo/omo.jsonc")
    writeFileSync(
      path,
      JSON.stringify({
        agents: { [agent]: { model: primary, permission: { bash: "deny" } } },
        categories: { quick: { model: primary, description: "activation" } },
      }),
    )
    const activation = validatePluginConfig(directory)
    const config = activation.config
    const warnings: string[] = []
    const reload = createModelConfigReload({
      directory,
      config,
      activation,
      load: validatePluginConfig,
      report: (message) => warnings.push(message),
    })
    const fake = createFakePluginContext({ models: [hostModel] })
    const hooks: Hooks = {}
    bindAgentModelOverrides(hooks, config.agents)
    const dispose = await installHooks(fake.context, hooks, { warn: () => {} })
    let observed: (() => void) | undefined
    const stop = reload.watch(() => {
      reload.reload()
      observed?.()
    })
    const admitted: V2ToolBeforeEvent = {
      tool: "subagent",
      sessionID: "ses_parent",
      agent: "coordinator",
      messageID: "msg_1",
      id: "call_1",
      input: { agent },
    }
    await fake.triggerToolBefore(admitted)
    try {
      // when
      await new Promise<void>((resolve) => {
        observed = () => {
          if (config.agents?.[agent]?.model === "openai/gpt-6-luna") resolve()
        }
        writeFileSync(
          `${path}.next`,
          JSON.stringify({
            "[opencode]": { disabled_providers: ["openai"] },
            agents: { [agent]: { models: ["openai/gpt-6-luna", "test/fallback"], permission: { bash: "allow" } } },
            categories: { quick: { models: ["test/category", "test/category-fallback"], description: "edited" } },
          }),
        )
        renameSync(`${path}.next`, path)
      })
      const next = { ...admitted, id: "call_2", input: { agent } }
      await fake.triggerToolBefore(next)
      // then
      expect(next.input).toEqual({ agent, model: "openai/gpt-6-luna" })
      expect(admitted.input).toEqual({ agent, model: primary })
      expect(config.agents?.[agent]?.fallback_models).toEqual(["test/fallback"])
      expect(config.agents?.[agent]?.permission).toEqual({ bash: "deny" })
      expect(config.categories?.quick?.models).toEqual(["test/category", "test/category-fallback"])
      expect(config.categories?.quick?.description).toBe("activation")

      // when
      await new Promise<void>((resolve) => {
        observed = () => {
          if (warnings.length > 0) resolve()
        }
        writeFileSync(path, '{ "agents": {')
      })
      // then
      expect(config.agents?.[agent]?.model).toBe("openai/gpt-6-luna")
      expect(warnings.join("\n")).toContain("keeping the last valid models")
      writeFileSync(path, JSON.stringify({ agents: { [agent]: { model: 17 } } }))
      reload.reload()
      expect(config.agents?.[agent]?.model).toBe("openai/gpt-6-luna")
    } finally {
      stop()
      await dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("uses the current model snapshot for a new child without changing an earlier request", async () => {
    // given
    const fake = createFakePluginContext({ models: [hostModel] })
    const hooks: Hooks = {}
    bindAgentModelOverrides(hooks, { [agent]: { model: primary } })
    const dispose = await installHooks(fake.context, hooks, { warn: () => {} })
    const admitted: V2ToolBeforeEvent = {
      tool: "subagent",
      sessionID: "ses_parent",
      agent: "coordinator",
      messageID: "msg_1",
      id: "call_1",
      input: { agent },
    }
    await fake.triggerToolBefore(admitted)

    // when
    bindAgentModelOverrides(hooks, { [agent]: { model: "openai/gpt-6-luna" } })
    const next = { ...admitted, id: "call_2", input: { agent } }
    try {
      await fake.triggerToolBefore(next)
      // then
      expect(next.input).toEqual({ agent, model: "openai/gpt-6-luna" })
      expect(admitted.input).toEqual({ agent, model: primary })
    } finally {
      await dispose()
    }
  })

  test.each([
    {
      name: "supported reasoning",
      settings: { reasoning: "xhigh" },
      variants: [{ id: "xhigh" }],
      model: `${primary}#xhigh`,
    },
    {
      name: "supported custom variant",
      settings: { variant: "host-custom" },
      variants: [{ id: "host-custom" }],
      model: `${primary}#host-custom`,
    },
    { name: "unsupported reasoning", settings: { reasoning: "xhigh" }, variants: [{ id: "low" }], model: primary },
  ])(
    "injects the configured primary for $name before the host creates a new child",
    async ({ settings, variants, model }) => {
      // given
      const fake = createFakePluginContext({ models: [{ ...hostModel, variants }] })
      const hooks: Hooks = {}
      bindAgentModelOverrides(hooks, {
        [agent]: {
          model: primary,
          ...settings,
          fallback_models: ["openai/gpt-6-luna", "github-copilot/claude-haiku-4.5"],
        },
      })
      const dispose = await installHooks(fake.context, hooks, { warn: () => {} })
      const event: V2ToolBeforeEvent = {
        tool: "subagent",
        sessionID: "ses_parent",
        agent: "coordinator",
        messageID: "msg_1",
        id: "call_1",
        input: { agent, background: true, prompt: "work" },
      }

      // when
      await fake.triggerToolBefore(event)

      // then
      expect(event.input).toEqual({ agent, background: true, prompt: "work", model })
      await dispose()
      const unloaded = { ...event, input: { agent, prompt: "after unload" } }
      await fake.triggerToolBefore(unloaded)
      expect(unloaded.input).toEqual({ agent, prompt: "after unload" })
    },
  )

  test.each([
    { name: "explicit model", tool: "subagent", input: { agent, model: "openai/gpt-6-luna#high" } },
    { name: "session follow-up", tool: "subagent", input: { agent, sessionID: "ses_child" } },
    { name: "no override", tool: "subagent", input: { agent: "unconfigured" } },
    { name: "override without model", tool: "subagent", input: { agent: "reasoning-only" } },
    { name: "non-subagent tool", tool: "other", input: { agent } },
  ])("preserves $name", async ({ tool, input }) => {
    // given
    const fake = createFakePluginContext({ models: [hostModel] })
    const hooks: Hooks = {}
    bindAgentModelOverrides(hooks, {
      [agent]: { model: primary, reasoning: "xhigh" },
      "reasoning-only": { reasoning: "high" },
    })
    const dispose = await installHooks(fake.context, hooks, { warn: () => {} })
    const event: V2ToolBeforeEvent = {
      tool,
      sessionID: "ses_parent",
      agent: "coordinator",
      messageID: "msg_1",
      id: "call_1",
      input,
    }
    const expected = structuredClone(input)

    // when
    await fake.triggerToolBefore(event)

    // then
    expect(event.input).toEqual(expected)
    await dispose()
  })
})
