import { describe, expect, test } from "bun:test"

import { CATEGORY_PROMPT_APPENDS } from "./builtin-categories"
import { createDelegateTaskPresentation } from "./tool-description"

describe("createDelegateTaskPresentation", () => {
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
    expect(description.slice(hint, description.indexOf("\n", hint))).toContain(routing.ladder.join(" → "))
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
    expect(absent.categoryExamples).toBe(createDelegateTaskPresentation({}).categoryExamples)
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
