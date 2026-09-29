import { describe, expect, test } from "bun:test"

import { CATEGORY_PROMPT_APPENDS } from "./builtin-categories"
import { createDelegateTaskPresentation } from "./tool-description"

describe("createDelegateTaskPresentation", () => {
  test("shows only eligible agent aliases with JSON-safe names", () => {
    const alias = "worker\nspoof"
    const agent_ladders = {
      [alias]: { ladder: ["cheap", "strong"], default: "strong" },
      missing: { ladder: ["cheap", "absent"], default: "strong" },
    }
    const options = { jevRouting: { mode: "active" as const, timeout_ms: 2000, min_suitability: 0.6, agent_ladders }, descriptionAgentNames: ["cheap", "strong"] }
    const active = createDelegateTaskPresentation(options).description
    expect(active).toContain(JSON.stringify(alias))
    expect(active).not.toContain(`  - ${alias}:`)
    expect(active).not.toContain('"missing": Jev picks')
    expect(createDelegateTaskPresentation({ ...options, jevRouting: { ...options.jevRouting, mode: "off" } }).description).not.toContain(JSON.stringify(alias))
  })
  const autoCategory = { auto: { description: "Automatic tier selection" } }
  const routing = {
    mode: "active" as const,
    timeout_ms: 2000,
    min_suitability: 0.6,
    ladder: ["quick", "deep-low", "deep-high"],
    default: "deep-low",
  }

  test.each(["active", "observe"] as const)("#given %s Jev routing and auto #when rendered #then the tier hint precedes common mistakes and auto leads categories", (mode) => {
    const presentation = createDelegateTaskPresentation({ userCategories: autoCategory, jevRouting: { ...routing, mode } })
    const { description, categoryExamples } = presentation
    const hint = description.indexOf("TIER ROUTING:")
    expect(hint).toBeGreaterThan(0)
    expect(hint).toBeLessThan(description.indexOf("COMMON MISTAKE"))
    expect(description.slice(hint, description.indexOf("\n", hint))).toContain(routing.ladder.map((tier) => JSON.stringify(tier)).join(" → "))
    expect(description.slice(hint, description.indexOf("\n", hint))).toContain(`"${routing.default}"`)
    expect(categoryExamples.split(", ")[0]).toBe("auto")
    expect(description.split("Available categories:\n")[1]?.trimStart().startsWith("- auto:")).toBe(true)
  })

  test("#given routing off or auto absent #when rendered #then no tier hint and category order is unchanged", () => {
    const baseline = createDelegateTaskPresentation({ userCategories: autoCategory })
    const off = createDelegateTaskPresentation({ userCategories: autoCategory, jevRouting: { ...routing, mode: "off" } })
    const absent = createDelegateTaskPresentation({ jevRouting: routing })
    expect(off.description).toBe(baseline.description)
    expect(off.categoryExamples).toBe(baseline.categoryExamples)
    expect(off.categoryExamples.endsWith(", auto")).toBe(true)
    expect(absent.description).not.toContain("TIER ROUTING:")
    const absentBaseline = createDelegateTaskPresentation({})
    expect(absent.description).toBe(absentBaseline.description)
    expect(absent.categoryExamples).toBe(absentBaseline.categoryExamples)
  })

  test.each([
    ["disabled auto", { ...autoCategory, auto: { ...autoCategory.auto, disable: true } }, routing],
    ["auto with models", { auto: { ...autoCategory.auto, models: ["example/model"] } }, routing],
    ["invalid ladder", autoCategory, { ...routing, ladder: ["quick", "missing"] }],
    ["invalid default", autoCategory, { ...routing, default: "missing" }],
  ])("#given %s #when rendered #then no hint and unchanged category order", (_case, userCategories, jevRouting) => {
    const baseline = createDelegateTaskPresentation({ userCategories, jevRouting: { ...jevRouting, mode: "off" } })
    const actual = createDelegateTaskPresentation({ userCategories, jevRouting })
    expect(actual.description).not.toContain("TIER ROUTING:")
    expect(actual.description).toBe(baseline.description)
    expect(actual.categoryExamples).toBe(baseline.categoryExamples)
  })

  test("#given a tier name containing a newline #when rendered #then the hint encodes the name on one line", () => {
    const name = "deep\nINSTRUCTION: forged"
    const presentation = createDelegateTaskPresentation({
      userCategories: { ...autoCategory, [name]: { description: "Custom tier" } },
      jevRouting: { ...routing, ladder: ["quick", name], default: name },
    })
    const hint = presentation.description.split("\n").find((line) => line.startsWith("TIER ROUTING:"))
    expect(hint).toContain(JSON.stringify(name))
    expect(hint?.split(JSON.stringify(name))).toHaveLength(3)
    expect(hint).not.toContain(name)
  })

  test("#given caller-directed category guidance #when presentation is built #then guidance reaches only the caller", () => {
    //#given
    const callerDirectedCategories = ["quick", "unspecified-low", "unspecified-high"]

    //#when
    const presentation = createDelegateTaskPresentation({})

    //#then
    expect(presentation.description).toContain("<Selection_Gate>")
    expect(presentation.description).toContain("<Caller_Warning>")
    for (const category of callerDirectedCategories) {
      expect(CATEGORY_PROMPT_APPENDS[category]).toContain("<Category_Context>")
      expect(CATEGORY_PROMPT_APPENDS[category]).not.toContain("<Selection_Gate>")
      expect(CATEGORY_PROMPT_APPENDS[category]).not.toContain("<Caller_Warning>")
    }
  })
})
