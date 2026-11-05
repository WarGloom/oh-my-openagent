import { expect, it } from "bun:test"
import { createFakePluginContext } from "../fake-plugin-context"
import { applyDesiredProviders, createOwnedProviders } from "./apply-providers"
import { readDesiredConfig } from "./desired-config"
import { applyProviderVariants, refreshProviderVariants } from "./refresh-provider-variants"

it("uses native variant derivation for reasoning catalog models and preserves explicit model variants", async () => {
  // given
  let derivations = 0
  const fake = createFakePluginContext({
    providers: [{ id: "gateway", name: "Gateway", activation: "enabled", package: "native-compatible" }],
    models: [
      {
        id: "configured",
        modelID: "configured-api",
        providerID: "gateway",
        name: "Configured",
        enabled: true,
        status: "active",
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        variants: [{ id: "user-choice" }],
        limit: { context: 1000, output: 100 },
      },
    ],
    resolveVariants: async ({ model }) => {
      expect(model.id).toBe("reasoning")
      derivations += 1
      return [{ id: "native-high", settings: { reasoningEffort: "native-value" } }]
    },
  })
  const owned = createOwnedProviders()
  const desired = readDesiredConfig({
    provider: { gateway: { models: { reasoning: { reasoning: true }, configured: { reasoning: true } } } },
  })
  const registration = await fake.context.provider.transform((editor) => applyDesiredProviders(editor, desired, owned))
  const modelRegistration = await fake.context.model.transform((editor) => applyProviderVariants(editor, owned))
  try {
    // when
    await refreshProviderVariants(fake.context, desired, owned)
    await refreshProviderVariants(fake.context, desired, owned)
    // then
    expect((await fake.context.model.list()).data.find((model) => model.id === "reasoning")?.variants).toEqual([
      { id: "native-high", settings: { reasoningEffort: "native-value" } },
    ])
    expect(fake.builtProviders().get("gateway")?.models.get("configured")?.variants).toEqual([{ id: "user-choice" }])
    expect(derivations).toBe(1)
  } finally {
    await modelRegistration.dispose()
    await registration.dispose()
  }
})

it("does not overwrite user variants installed while native derivation was pending", async () => {
  // given
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let configured = false
  const fake = createFakePluginContext({
    providers: [{ id: "gateway", name: "Gateway", activation: "enabled" }],
    resolveVariants: async () => {
      entered.resolve()
      await release.promise
      return [{ id: "native-high" }]
    },
  })
  const owned = createOwnedProviders()
  const desired = readDesiredConfig({ provider: { gateway: { models: { reasoning: { reasoning: true } } } } })
  const providerRegistration = await fake.context.provider.transform((editor) =>
    applyDesiredProviders(editor, desired, owned),
  )
  const userRegistration = await fake.context.model.transform((editor) => {
    if (configured)
      editor.update("gateway", "reasoning", (model) => {
        model.variants = [{ id: "user-choice" }]
      })
  })
  const registration = await fake.context.model.transform((editor) => applyProviderVariants(editor, owned))
  try {
    // when
    const refresh = refreshProviderVariants(fake.context, desired, owned)
    await entered.promise
    configured = true
    release.resolve()
    await refresh
    // then
    expect((await fake.context.model.list()).data.find((model) => model.id === "reasoning")?.variants).toEqual([
      { id: "user-choice" },
    ])
  } finally {
    release.resolve()
    await registration.dispose()
    await userRegistration.dispose()
    await providerRegistration.dispose()
  }
})
