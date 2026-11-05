import type { V2PluginContext } from "../context-types"
import type { ProviderBaseline } from "./desired-config"
import type { OwnedProviders } from "./apply-providers"

const nativeSnapshots = new WeakSet<object>()

export function isNativeConfigSnapshot(config: object): boolean {
  return nativeSnapshots.has(config)
}

export type ConfigSnapshot = {
  readonly config: Record<string, unknown>
  /** The provider and model ids `config.provider` carries from host state. */
  readonly providerBaseline: ProviderBaseline
}

/**
 * The 1.x config object the plugin's `config` hook expects to receive and mutate. 2.x does not hand
 * plugins the merged config, so the snapshot carries what the host can report: the default model,
 * each available provider's request headers and each available model's context limit. Providers and
 * models the bridge registered itself are left out, so the hook sees host state as 1.x would and adds
 * them again. Other sections are empty maps the hook fills in.
 */
export async function buildConfigSnapshot(context: V2PluginContext, owned: OwnedProviders): Promise<ConfigSnapshot> {
  const defaultModel = (await context.model.default()).data
  const provider: Record<string, { options?: { headers: Record<string, string> }; models: Record<string, unknown> }> =
    {}
  const baseline = new Map<string, Set<string>>()
  for (const info of (await context.provider.list()).data) {
    if (owned.providers.has(info.id)) continue
    provider[info.id] = { ...(info.headers ? { options: { headers: { ...info.headers } } } : {}), models: {} }
    baseline.set(info.id, new Set())
  }
  for (const model of (await context.model.list()).data) {
    const entry = provider[model.providerID]
    if (!entry || owned.models.get(model.providerID)?.has(model.id)) continue
    entry.models[model.id] = { limit: { context: model.limit.context } }
    baseline.get(model.providerID)?.add(model.id)
  }
  for (const configured of await context.experimental.model.configuredInputs()) {
    const entry = provider[configured.providerID]
    if (!entry) continue
    const current = entry.models[configured.modelID]
    entry.models[configured.modelID] = {
      ...(typeof current === "object" && current !== null ? current : {}),
      modalities: { input: [...configured.input] },
    }
    baseline.get(configured.providerID)?.add(configured.modelID)
  }
  const config = {
    ...(defaultModel ? { model: `${defaultModel.providerID}/${defaultModel.modelID}` } : {}),
    agent: {},
    command: {},
    mcp: {},
    provider,
  }
  nativeSnapshots.add(config)
  return {
    config,
    providerBaseline: baseline,
  }
}
