import type { V2ModelEditor, V2PluginContext } from "../context-types"
import type { OwnedProviders } from "./apply-providers"
import type { DesiredConfig } from "./desired-config"

export async function refreshProviderVariants(
  context: V2PluginContext,
  desired: DesiredConfig,
  owned: OwnedProviders,
): Promise<void> {
  const models = (await context.model.list()).data
  let changed = false
  for (const [providerID, provider] of desired.providers) {
    for (const [modelID, model] of provider.models) {
      if (!model.reasoning || !owned.models.get(providerID)?.has(modelID)) continue
      const effective = models.find((entry) => entry.providerID === providerID && entry.id === modelID)
      if (!effective) continue
      const key = `${providerID}/${modelID}`
      const previous = owned.variants.get(key)
      if (effective.variants.length && JSON.stringify(effective.variants) !== JSON.stringify(previous?.values)) continue
      const signature = JSON.stringify({ ...effective, variants: [] })
      if (previous?.signature === signature) continue
      const inputSignature = owned.modelInputs.get(key)
      if (inputSignature === undefined) continue
      const variants = await context.experimental.variant.resolve({ model: effective })
      if (inputSignature !== owned.modelInputs.get(key)) continue
      owned.variants.set(key, { signature, inputSignature, values: variants })
      if (JSON.stringify(previous?.values ?? []) !== JSON.stringify(variants)) changed = true
    }
  }
  if (changed) await context.model.reload()
}

export function applyProviderVariants(editor: V2ModelEditor, owned: OwnedProviders): void {
  for (const [providerID, modelIDs] of owned.models) {
    for (const modelID of modelIDs) {
      const key = `${providerID}/${modelID}`
      const cached = owned.variants.get(key)
      const effective = editor.get(providerID, modelID)
      const inputSignature = JSON.stringify({
        model: { ...effective, variants: [] },
        provider: editor.provider.get(providerID)?.provider,
      })
      owned.modelInputs.set(key, inputSignature)
      if (!cached?.values.length || !effective || effective.variants.length) continue
      if (cached.inputSignature !== inputSignature) continue
      editor.update(providerID, modelID, (model) => {
        if (model.variants.length === 0) model.variants = [...cached.values]
      })
    }
  }
}
