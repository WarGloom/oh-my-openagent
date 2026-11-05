import { expect, it } from "bun:test"
import type { V2ConfiguredModelInputs, V2ModelInfo } from "../context-types"
import { createFakePluginContext } from "../fake-plugin-context"
import { createModelCacheState } from "../../plugin-state"
import { applyProviderConfig } from "../../plugin-handlers/provider-config-handler"
import { buildConfigSnapshot } from "./snapshot"
import { createOwnedProviders } from "./apply-providers"
import { createBuiltinAgents } from "../../agents/builtin-agents"

it("projects explicit configured vision using registry IDs, clears removal, and excludes catalog-only vision", async () => {
  // given
  const model: V2ModelInfo = {
    id: "configured", modelID: "api-alias", providerID: "custom", name: "Custom", enabled: true, status: "active",
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] }, variants: [], limit: { context: 123_456, output: 1000 },
  }
  const configuredInputs: V2ConfiguredModelInputs[] = [{ providerID: "custom", modelID: "configured", input: ["text", "image"] }]
  const fake = createFakePluginContext({
    providers: [{ id: "custom", name: "Custom", activation: "enabled" }],
    models: [model, { ...model, id: "catalog-only", modelID: "catalog-api" }], configuredInputs,
  })
  const cache = createModelCacheState()
  const read = async () => {
    const snapshot = await buildConfigSnapshot(fake.context, createOwnedProviders())
    applyProviderConfig({ config: snapshot.config, modelCacheState: cache })
  }
  // when
  await read()
  // then
  expect([...cache.visionCapableModelsCache?.values() ?? []]).toEqual([{ providerID: "custom", modelID: "configured" }])
  expect((await createBuiltinAgents())["multimodal-looker"]?.model).toBe("custom/configured")
  expect((await createBuiltinAgents([], { "multimodal-looker": { model: "explicit/user-choice" } }))["multimodal-looker"]?.model).toBe("explicit/user-choice")
  expect([...cache.modelContextLimitsCache]).toEqual([["custom/configured", 123_456], ["custom/catalog-only", 123_456]])
  // when an explicit false/removal leaves a live model without input modalities
  configuredInputs[0] = { providerID: "custom", modelID: "configured", input: [] }
  await read()
  // then
  expect([...cache.visionCapableModelsCache?.values() ?? []]).toEqual([])
  expect((await createBuiltinAgents())["multimodal-looker"]?.model).not.toBe("custom/configured")
  expect((await createBuiltinAgents())["multimodal-looker"]?.model).not.toBe("custom/catalog-only")
  expect(cache.modelContextLimitsCache.get("custom/configured")).toBe(123_456)
  // when the configured model is removed or disabled at the native projection owner
  configuredInputs.length = 0
  await read()
  // then
  expect([...cache.visionCapableModelsCache?.values() ?? []]).toEqual([])
})
