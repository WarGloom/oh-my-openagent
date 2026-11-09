/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"

import { parseInlineTeamSpec, resolveDefaultInlineCategory } from "./lifecycle-inline-spec"
import { JevRoutingConfigSchema } from "../../../config/schema/jev-routing"

describe("parseInlineTeamSpec default category fallback", () => {
  test("defaults to auto when routing is enabled and preserves category order when off", () => {
    const categories = { writing: {}, quick: {} }
    const enabled = JevRoutingConfigSchema.parse({ mode: "active", default: "quick" })
    const off = JevRoutingConfigSchema.parse({ mode: "off" })
    const agentOnly = JevRoutingConfigSchema.parse({
      mode: "active",
      agent_ladders: { helper: { ladder: ["a", "b"], default: "a" } },
    })
    expect(resolveDefaultInlineCategory(categories, enabled)).toBe("auto")
    expect(resolveDefaultInlineCategory(categories, off)).toBe("writing")
    expect(resolveDefaultInlineCategory(categories, agentOnly)).toBe("writing")
  })
  test("accepts explicit category-kind members when the category is omitted but a fallback exists", () => {
    // given
    const inlineSpec = {
      name: "Hyper Decision",
      members: [
        {
          name: "minimalist",
          kind: "category",
          prompt: "Decide the MCP result contract with minimal complexity.",
        },
      ],
    }

    // when
    const spec = parseInlineTeamSpec(inlineSpec, { defaultCategoryName: "quick" })

    // then
    expect(spec).toMatchObject({
      name: "hyper-decision",
      leadAgentId: "minimalist",
      members: [{ name: "minimalist", kind: "category", category: "quick" }],
    })
  })
})
