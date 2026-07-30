/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"

import { parseInlineTeamSpec } from "./lifecycle-inline-spec"

describe("parseInlineTeamSpec default category fallback", () => {
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
      members: [
        { name: "minimalist", kind: "category", category: "quick" },
      ],
    })
  })
})
