import { describe, expect, it } from "bun:test"
import { createFakePluginContext } from "../fake-plugin-context"
import { createSessionTracker } from "../session-tracker"
import { createClientFacade } from "./create-client-facade"

describe("V2 facade domain parity", () => {
  it("updates titles through the native session domain and returns the V1 session", async () => {
    // given
    const fake = createFakePluginContext()
    let title = "Original"
    const context = { ...fake.context, session: { ...fake.context.session,
      update: async (input: { title?: string }) => { if (input.title !== undefined) title = input.title },
      get: async ({ sessionID }: { sessionID: string }) => ({ ...await fake.context.session.get({ sessionID }), title }),
    } }
    const client = createClientFacade(context, { tracker: createSessionTracker(), warn: () => {} })
    // when
    const result = await client.session.update({ path: { id: "child" }, body: { title: "Task [fallback]" } })
    // then
    expect(result.data).toMatchObject({ id: "child", title: "Task [fallback]" })
  })

  it("lists models with the provider and model ID that availability resolution reads", async () => {
    // given
    const fake = createFakePluginContext({ models: [{
      id: "p/m", modelID: "m", providerID: "p", name: "Model", status: "active", enabled: true,
      capabilities: { tools: true, input: ["text", "image"], output: ["text"], temperature: false },
      settings: { customModel: 42 }, variants: [{ id: "high", settings: { effort: "high" } }], limit: { context: 100, output: 20 },
    }], providers: [{ id: "p", name: "Provider", activation: "enabled", settings: { baseURL: "https://example.invalid" }, headers: { "custom-header": "value" } }] })
    const client = createClientFacade(fake.context, { tracker: createSessionTracker(), warn: () => {} })
    // when
    const result = await client.model.list()
    // then
    expect(result.data).toMatchObject([{ id: "m", provider: "p", providerID: "p", attachment: true, temperature: false,
      options: { customModel: 42 }, variants: { high: { effort: "high" } }, limit: { context: 100, output: 20 } }])
    const provider = await client.provider.list()
    expect(provider.data?.all[0]).toMatchObject({ options: { baseURL: "https://example.invalid", headers: { "custom-header": "value" } } })
  })
})
