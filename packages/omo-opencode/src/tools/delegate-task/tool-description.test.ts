import { describe, expect, test } from "bun:test"
import { CATEGORY_PROMPT_APPENDS } from "./builtin-categories"
import { createDelegateTaskPresentation } from "./tool-description"
import { JevRoutingConfigSchema } from "../../config/schema/jev-routing"

describe("createDelegateTaskPresentation", () => {
  test("shows only eligible agent aliases with JSON-safe names", () => {
    const alias = "worker\nspoof"
    const agent_ladders = {
      [alias]: { ladder: ["cheap", "strong"], default: "strong" },
      missing: { ladder: ["cheap", "absent"], default: "strong" },
    }
    const options = {
      jevRouting: JevRoutingConfigSchema.parse({ mode: "active", agent_ladders }),
      descriptionAgentNames: ["cheap", "strong"],
    }
    const active = createDelegateTaskPresentation(options).description
    expect(active).toContain(JSON.stringify(alias))
    expect(active).not.toContain(`  - ${alias}:`)
    expect(active).not.toContain('"missing": Jev picks')
    expect(
      createDelegateTaskPresentation({ ...options, jevRouting: { ...options.jevRouting, mode: "off" } }).description,
    ).not.toContain(JSON.stringify(alias))
  })

  test.each(["active", "observe"] as const)(
    "presents auto first by default in %s mode without a category declaration",
    (mode) => {
      const presentation = createDelegateTaskPresentation({
        jevRouting: JevRoutingConfigSchema.parse({ mode, default: "unspecified-low" }),
      })
      expect(presentation.availableCategories[0]?.name).toBe("auto")
      expect(presentation.categoryExamples.split(", ")[0]).toBe("auto")
      expect(presentation.availableCategories.some((category) => category.name === "quick")).toBe(true)
    },
  )

  test("keeps auto first for externally supplied category lists", () => {
    const presentation = createDelegateTaskPresentation({
      availableCategories: [{ name: "custom", description: "User category" }],
      jevRouting: JevRoutingConfigSchema.parse({ mode: "active", default: "quick" }),
    })
    expect(presentation.availableCategories.map((category) => category.name)).toEqual(["auto", "custom"])
  })

  test("routing off retains explicit category presentation", () => {
    const baseline = createDelegateTaskPresentation({})
    const off = createDelegateTaskPresentation({ jevRouting: JevRoutingConfigSchema.parse({ mode: "off" }) })
    expect(off.availableCategories).toEqual(baseline.availableCategories)
    expect(off.categoryExamples).toBe(baseline.categoryExamples)
    expect(off.availableCategories.some((category) => category.name === "auto")).toBe(false)
    const noDefault = createDelegateTaskPresentation({ jevRouting: JevRoutingConfigSchema.parse({ mode: "active" }) })
    expect(noDefault.availableCategories.some((category) => category.name === "auto")).toBe(false)
  })

  test("caller-directed category guidance reaches only the caller", () => {
    const presentation = createDelegateTaskPresentation({})
    expect(presentation.description).toContain("<Selection_Gate>")
    expect(presentation.description).toContain("<Caller_Warning>")
    for (const category of ["quick", "unspecified-low", "unspecified-high"]) {
      expect(CATEGORY_PROMPT_APPENDS[category]).toContain("<Category_Context>")
      expect(CATEGORY_PROMPT_APPENDS[category]).not.toContain("<Selection_Gate>")
      expect(CATEGORY_PROMPT_APPENDS[category]).not.toContain("<Caller_Warning>")
    }
  })
})
