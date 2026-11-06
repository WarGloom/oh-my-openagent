import type { OhMyOpenCodeConfig } from "../config"
import type { PluginConfigValidation, validatePluginConfig } from "../config/validate"
import { watchModelConfigFiles } from "./model-config-watch"

const MODEL_FIELDS = ["model", "models", "fallback_models"] as const
type ModelSettings = Pick<NonNullable<NonNullable<OhMyOpenCodeConfig["agents"]>[string]>, (typeof MODEL_FIELDS)[number]>

function modelEntries(
  base: Readonly<Record<string, ModelSettings | undefined>>,
  candidate: Readonly<Record<string, ModelSettings | undefined>>,
): Record<string, ModelSettings> {
  return Object.fromEntries(
    Object.keys(base).map((name) => {
      const entry: ModelSettings = { ...base[name] }
      for (const field of MODEL_FIELDS) delete entry[field]
      const settings = candidate[name]
      return [
        name,
        {
          ...entry,
          ...(settings?.model === undefined ? {} : { model: settings.model }),
          ...(settings?.models === undefined ? {} : { models: settings.models }),
          ...(settings?.fallback_models === undefined ? {} : { fallback_models: settings.fallback_models }),
        },
      ]
    }),
  )
}

export function createModelConfigReload(input: {
  readonly directory: string
  readonly config: OhMyOpenCodeConfig
  readonly activation: PluginConfigValidation
  readonly load: typeof validatePluginConfig
  readonly report: (message: string) => void
}) {
  // Consumers retain these maps; publication replaces entries, never admitted request values.
  const agents = (input.config.agents ??= {})
  const categories = (input.config.categories ??= {})
  const base = input.activation.modelConfigBase ?? input.activation.config
  const baseAgents = { ...base.agents }
  const baseCategories = { ...base.categories }
  const baseline = new Set([...input.activation.messages, ...(input.activation.warnings ?? [])])
  let key = JSON.stringify([agents, categories])
  let diagnostic = ""
  return {
    reload(): void {
      const candidate = input.load(input.directory, process.env, (config) => ({
        ...config,
        disabled_providers: input.config.disabled_providers,
        agents: modelEntries(baseAgents, config.agents ?? {}),
        categories: modelEntries(baseCategories, config.categories ?? {}),
      }))
      const messages = [...candidate.messages, ...(candidate.warnings ?? [])]
      const rejected = messages.some((message) => !baseline.has(message))
      const nextDiagnostic = JSON.stringify([rejected, messages])
      if (messages.length > 0 && nextDiagnostic !== diagnostic) {
        input.report(
          `${rejected ? "Model config reload rejected; keeping the last valid models." : "Model config reload diagnostics."} ${messages.join("; ")}`,
        )
      }
      diagnostic = nextDiagnostic
      if (rejected) return
      const nextAgents = candidate.config.agents ?? {}
      const nextCategories = candidate.config.categories ?? {}
      const nextKey = JSON.stringify([nextAgents, nextCategories])
      if (key === nextKey) return
      for (const name of Object.keys(agents)) if (!(name in nextAgents)) delete agents[name]
      for (const name of Object.keys(categories)) if (!(name in nextCategories)) delete categories[name]
      Object.assign(agents, nextAgents)
      Object.assign(categories, nextCategories)
      key = nextKey
    },
    watch(notify: () => void): () => void {
      return watchModelConfigFiles({ directory: input.directory, notify, report: input.report })
    },
  }
}

const reloads = new WeakMap<object, ReturnType<typeof createModelConfigReload>>()

export function bindModelConfigReload(hook: object, reload: ReturnType<typeof createModelConfigReload>): void {
  reloads.set(hook, reload)
}

export function getModelConfigReload(hook: object): ReturnType<typeof createModelConfigReload> | undefined {
  return reloads.get(hook)
}
