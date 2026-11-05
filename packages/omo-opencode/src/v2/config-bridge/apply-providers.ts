import type { V2IntegrationEditor, V2ProviderEditor, V2ModelInfo } from "../context-types"
import type { DesiredConfig } from "./desired-config"

/** Providers and models the bridge created on the host, so the next snapshot can leave them out. */
export type OwnedProviders = {
  readonly providers: Set<string>
  readonly models: Map<string, Set<string>>
  readonly variants: Map<
    string,
    { readonly signature: string; readonly inputSignature: string; readonly values: V2ModelInfo["variants"] }
  >
  readonly modelInputs: Map<string, string>
}

export function createOwnedProviders(): OwnedProviders {
  return { providers: new Set(), models: new Map(), variants: new Map(), modelInputs: new Map() }
}

/**
 * Registers the hook's providers with 1.x `fillMissing` precedence: a provider or model another
 * source already defined keeps every field it set, and only absent fields and model ids are filled.
 * New providers keep the host's `auto` activation, so their integration connection decides availability.
 */
export function applyDesiredProviders(editor: V2ProviderEditor, desired: DesiredConfig, owned: OwnedProviders): void {
  owned.providers.clear()
  owned.models.clear()
  for (const [id, wanted] of desired.providers) {
    const existing = editor.get(id)
    if (!existing) owned.providers.add(id)
    editor.update(id, (provider) => {
      if (wanted.name !== undefined && (!existing || provider.name === id)) provider.name = wanted.name
      if (wanted.package !== undefined && provider.package === "") provider.package = wanted.package
      if (wanted.settings) provider.settings = { ...wanted.settings, ...provider.settings }
      if (wanted.headers) provider.headers = { ...wanted.headers, ...provider.headers }
    })
    const ownedModels = new Set<string>()
    for (const [modelID, model] of wanted.models) {
      if (editor.get(id)?.models.has(modelID)) continue
      ownedModels.add(modelID)
      editor.models.update(id, modelID, (draft) => {
        if (model.name !== undefined) draft.name = model.name
        if (model.tools !== undefined) draft.capabilities.tools = model.tools
        if (model.input) draft.capabilities.input = [...model.input]
        if (model.output) draft.capabilities.output = [...model.output]
        if (model.limit) draft.limit = { ...draft.limit, ...model.limit }
        if (model.cost)
          draft.cost = [{ input: model.cost.input, output: model.cost.output, cache: { ...model.cost.cache } }]
      })
    }
    if (ownedModels.size > 0) owned.models.set(id, ownedModels)
  }
}

/**
 * Gives each provider the bridge created an integration to connect through: an API key method and the
 * hook's env names, as the host does for providers from config. An existing integration is left alone.
 */
export function applyDesiredIntegrations(
  editor: V2IntegrationEditor,
  desired: DesiredConfig,
  owned: OwnedProviders,
): void {
  for (const [id, wanted] of desired.providers) {
    if (!owned.providers.has(id) || editor.get(id)) continue
    editor.method.update({ integrationID: id, method: { type: "key", label: "Manually enter API Key" } })
    if (wanted.name !== undefined) {
      const name = wanted.name
      editor.update(id, (integration) => {
        integration.name = name
      })
    }
    if (wanted.env.length > 0)
      editor.method.update({ integrationID: id, method: { type: "env", names: [...wanted.env] } })
  }
}
