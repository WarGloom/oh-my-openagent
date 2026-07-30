/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { createDelegateTaskPresentation } from "./tool-description"
import { BUILTIN_SUBAGENT_TYPES, formatAvailableAgentTypesSection } from "./builtin-subagent-types"

describe("task tool description agent-types section", () => {
  test("is parseable by Meridian's agent-definition regex", () => {
    //#given
    const { description } = createDelegateTaskPresentation({
      manager: {} as never,
      client: {} as never,
      directory: ".",
    })

    //#when
    const agentSection = description.match(
      /Available agent types.*?:\n((?:- [\w][\w-]*:.*\n?)+)/s,
    )

    //#then
    expect(agentSection).not.toBeNull()
    const entries = [...agentSection![1]!.matchAll(/^- ([\w][\w-]*):\s*(.+)/gm)]
    const parsedNames = entries.map((m) => m[1])
    for (const builtin of BUILTIN_SUBAGENT_TYPES) {
      expect(parsedNames).toContain(builtin.name)
    }
    expect(parsedNames).not.toContain("hephaestus")
    expect(description).toContain('For implementation/deep-worker tasks, use category="deep" instead of subagent_type="hephaestus".')
  })

  test("formatAvailableAgentTypesSection emits bullets at column 0", () => {
    //#given/when
    const rendered = formatAvailableAgentTypesSection()

    //#then
    expect(rendered.startsWith("Available agent types:\n")).toBe(true)
    for (const builtin of BUILTIN_SUBAGENT_TYPES) {
      expect(rendered).toContain(`\n- ${builtin.name}: ${builtin.description}`)
    }
    expect(rendered).not.toContain("\n- hephaestus:")
    expect(rendered).toContain('For implementation/deep-worker tasks, use category="deep" instead of subagent_type="hephaestus".')
  })
})
