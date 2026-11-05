import type {
  V2IntegrationEditor,
  V2IntegrationMethod,
  V2ModelDraft,
  V2ModelInfo,
  V2ProviderDraft,
  V2ProviderEditor,
  V2ProviderDomain,
  V2IntegrationDomain,
  V2ModelEditor,
  V2ModelDomain,
} from "./context-types"
import type { FakeContextOptions } from "./fake-plugin-context"

export type FakeProviderRecord = { provider: V2ProviderDraft; models: Map<string, V2ModelInfo> }
export type FakeIntegrationRecord = { id: string; name: string; methods: V2IntegrationMethod[] }

export function createFakeProviderContext(options: FakeContextOptions) {
  const providerTransforms: Array<(editor: V2ProviderEditor) => void> = []
  let providersBuilt = new Map<string, FakeProviderRecord>()
  let providerReloads = 0
  const rebuildProviders = (): void => {
    providersBuilt = new Map(
      (options.providers ?? []).map((info) => [
        info.id,
        {
          provider: {
            ...info,
            package: info.package ?? "",
            ...(info.settings ? { settings: { ...info.settings } } : {}),
            ...(info.headers ? { headers: { ...info.headers } } : {}),
          },
          models: new Map(
            (options.models ?? []).filter((model) => model.providerID === info.id).map((model) => [model.id, model]),
          ),
        },
      ]),
    )
    const entry = (id: string): FakeProviderRecord => {
      const current = providersBuilt.get(id)
      if (current) return current
      const added: FakeProviderRecord = {
        provider: { id, name: id, activation: "auto", package: "" },
        models: new Map(),
      }
      providersBuilt.set(id, added)
      return added
    }
    const editor: V2ProviderEditor = {
      get: (id) => providersBuilt.get(id),
      update: (id, update) => update(entry(id).provider),
      models: {
        update: (providerID, modelID, update) => {
          const record = entry(providerID)
          const current = record.models.get(modelID)
          const draft: V2ModelDraft & V2ModelInfo = {
            ...current,
            id: modelID,
            modelID,
            providerID,
            name: current?.name ?? modelID,
            status: current?.status ?? "active",
            enabled: current?.enabled ?? true,
            capabilities: {
              tools: current?.capabilities.tools ?? true,
              input: [...(current?.capabilities.input ?? ["text", "image"])],
              output: [...(current?.capabilities.output ?? ["text"])],
            },
            variants: [...(current?.variants ?? [])],
            cost: [],
            limit: { ...(current?.limit ?? { context: 200_000, output: 32_000 }) },
          }
          update(draft)
          record.models.set(modelID, draft)
        },
      },
    }
    for (const transform of providerTransforms) transform(editor)
  }
  const integrationTransforms: Array<(editor: V2IntegrationEditor) => void> = []
  let integrationsBuilt = new Map<string, FakeIntegrationRecord>()
  let integrationReloads = 0
  const rebuildIntegrations = (): void => {
    integrationsBuilt = new Map()
    const entry = (id: string): FakeIntegrationRecord => {
      const current = integrationsBuilt.get(id)
      if (current) return current
      const added: FakeIntegrationRecord = { id, name: id, methods: [] }
      integrationsBuilt.set(id, added)
      return added
    }
    const editor: V2IntegrationEditor = {
      get: (id) => integrationsBuilt.get(id),
      update: (id, update) => update(entry(id)),
      method: {
        update: ({ integrationID, method }) => {
          const record = entry(integrationID)
          record.methods = [...record.methods.filter((existing) => existing.type !== method.type), method]
        },
      },
    }
    for (const transform of integrationTransforms) transform(editor)
  }
  const availableProviders = (): FakeProviderRecord[] =>
    [...providersBuilt.values()].filter(({ provider }) => {
      if (provider.activation === "disabled") return false
      if (provider.activation === "enabled") return true
      const integrationID = provider.integrationID ?? provider.id
      if (options.connectedIntegrations?.includes(integrationID)) return true
      return provider.integrationID === undefined && !integrationsBuilt.has(integrationID)
    })
  const provider: V2ProviderDomain = {
    list: async () => ({ data: availableProviders().map((record) => record.provider) }),
    transform: async (callback) => {
      providerTransforms.push(callback)
      rebuildProviders()
      rebuildModels()
      return {
        dispose: async () => {
          providerTransforms.splice(providerTransforms.indexOf(callback), 1)
          rebuildProviders()
          rebuildModels()
        },
      }
    },
    reload: async () => {
      providerReloads += 1
      rebuildProviders()
      rebuildModels()
    },
  }
  const integration: V2IntegrationDomain = {
    transform: async (callback) => {
      integrationTransforms.push(callback)
      rebuildIntegrations()
      rebuildModels()
      return {
        dispose: async () => {
          integrationTransforms.splice(integrationTransforms.indexOf(callback), 1)
          rebuildIntegrations()
          rebuildModels()
        },
      }
    },
    reload: async () => {
      integrationReloads += 1
      rebuildIntegrations()
      rebuildModels()
    },
  }
  rebuildProviders()
  const modelTransforms: Array<(editor: V2ModelEditor) => void> = []
  let effectiveModels: V2ModelInfo[] | undefined
  const listModels = (): V2ModelInfo[] => {
    const available = availableProviders()
    const availableIDs = new Set(available.map((record) => record.provider.id))
    const fixtureProviders = new Set((options.providers ?? []).map((info) => info.id))
    const fixtureModels = options.models ?? []
    return [
      ...fixtureModels.filter((model) => !fixtureProviders.has(model.providerID) || availableIDs.has(model.providerID)),
      ...available.flatMap((record) => [...record.models.values()].filter((model) => !fixtureModels.includes(model))),
    ]
  }
  const rebuildModels = (): void => {
    effectiveModels = listModels().map((item) => ({ ...item, variants: [...item.variants] }))
    const models = effectiveModels
    const editor: V2ModelEditor = {
      provider: { get: (providerID) => providersBuilt.get(providerID) },
      get: (providerID, modelID) => models.find((item) => item.providerID === providerID && item.id === modelID),
      update: (providerID, modelID, update) => {
        const item = models.find((entry) => entry.providerID === providerID && entry.id === modelID)
        if (!item) return
        const draft = { ...item, variants: [...item.variants] }
        update(draft)
        models.splice(models.indexOf(item), 1, draft)
      },
    }
    for (const transform of modelTransforms) transform(editor)
  }
  const model: V2ModelDomain = {
    list: async () => ({ data: effectiveModels ?? listModels() }),
    default: async () => ({ data: options.defaultModel ?? null }),
    transform: async (callback) => {
      modelTransforms.push(callback)
      rebuildModels()
      return {
        dispose: async () => {
          modelTransforms.splice(modelTransforms.indexOf(callback), 1)
          rebuildModels()
        },
      }
    },
    reload: async () => rebuildModels(),
  }
  return {
    provider,
    integration,
    model,
    builtProviders: () => providersBuilt,
    providerReloadCount: () => providerReloads,
    builtIntegrations: () => integrationsBuilt,
    integrationReloadCount: () => integrationReloads,
  }
}
