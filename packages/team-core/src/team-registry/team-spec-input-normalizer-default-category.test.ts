/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"

import { normalizeTeamSpecInput } from "./team-spec-input-normalizer"

describe("normalizeTeamSpecInput default category fallback", () => {
  test("uses the provided default category for explicit category-kind members missing category", () => {
    // given
    const rawSpec = {
      name: "hyper decision",
      members: [
        {
          name: "minimalist",
          kind: "category",
          prompt: "Decide the lowest-complexity MCP result contract.",
        },
      ],
    }

    // when
    const normalizedSpec = normalizeTeamSpecInput(rawSpec, {
      defaultCategoryName: "quick",
    })

    // then
    expect(normalizedSpec).toMatchObject({
      name: "hyper-decision",
      leadAgentId: "minimalist",
      members: [
        { name: "minimalist", kind: "category", category: "quick" },
      ],
    })
  })

  test("uses the provided default category for explicit category-kind members with null category", () => {
    // given
    const rawSpec = {
      name: "null category",
      members: [
        {
          name: "minimalist",
          kind: "category",
          category: null,
          prompt: "Decide the lowest-complexity MCP result contract.",
        },
      ],
    }

    // when
    const normalizedSpec = normalizeTeamSpecInput(rawSpec, {
      defaultCategoryName: "quick",
    })

    // then
    expect(normalizedSpec).toMatchObject({
      members: [
        { name: "minimalist", kind: "category", category: "quick" },
      ],
    })
  })
})
