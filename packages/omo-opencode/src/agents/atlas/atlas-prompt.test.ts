import { describe, expect, spyOn, test } from "bun:test"
import * as promptsCore from "@oh-my-opencode/prompts-core"
import { createAtlasAgent } from "./agent"

const VARIANTS = [
  ["default", "anthropic/claude-sonnet-4-6"],
  ["gpt", "openai/gpt-5.5"],
  ["gemini", "google/gemini-3.1-pro"],
  ["kimi", "moonshotai/kimi-k2.6"],
  ["kimi-k2-7", "opencode-go/kimi-k2.7"],
  ["kimi-k3", "opencode-go/kimi-k3"],
  ["opus-4-7", "anthropic/claude-opus-4-7"],
] as const

describe("Atlas factory prompt delivery", () => {
  for (const [variant, model] of VARIANTS) {
    test(`#given ${variant} model #when constructing Atlas #then its shipped source reaches the renderer`, async () => {
      // given - guard shipped source delivery, not authored prompt wording.
      const source = await Bun.file(new URL(
        `../../../../prompts-core/prompts/atlas/${variant}.md`,
        import.meta.url,
      )).text()
      const render = spyOn(promptsCore, "loadPromptSync")
      try {
        // when - the spy runs the real renderer, including runtime injections.
        createAtlasAgent({ model })

        // then - selector-only tests cannot detect a factory that ignores its selected source.
        expect(render).toHaveBeenCalledTimes(1)
        expect(render).toHaveBeenCalledWith(expect.objectContaining({
          name: "atlas",
          variant,
          source: {
            kind: "bundled",
            content: source,
            filePath: `packages/prompts-core/prompts/atlas/${variant}.md`,
          },
        }))
      } finally {
        render.mockRestore()
      }
    })
  }
})
