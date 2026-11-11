import { expect, test } from "bun:test"
import { inferJevCategory, parseJevCategoryResponse, questions } from "./jev-router-model"
import {
  PG_ARTIFACT,
  PG_ROUTER,
  PG_RULE,
  ROLLBACK_ARTIFACT,
  VISUAL_GUARDED_ARTIFACT,
  applyJevDecisionRule,
  selectJevArtifact,
} from "./jev-router-artifacts"
import { categoryReply, nonVisualVectors } from "./jev-router.test-support"
import { jevConfigGeneration } from "./jev-routing-context"

const examples = [
  {
    id: "prt_10e366fbb001zo7ZlKaogVmBjX",
    features: [
      0.67, 0, 0.32, 0, 0.01, 0, 0, 0.95, 0.88, 0, 0.01, 0.83, 0.16, 0, 0.19, 0.93, 0.79, 0.05, 0.02, 0, 0.78, 0.16,
      0.03, 0.03, 0.99, 0.62, 0.01, 0.98,
    ],
    probabilities: [
      0.9402312100107346, 0.0010145503449803352, 0.029968418553783877, 0.019497992086829646, 0.008846100985089258,
      0.0004417280185825268,
    ],
    expected: "deep-low",
  },
  {
    id: "prt_159f4ca79001ikM5i8Wd52WGQt",
    features: [
      0, 0, 0, 0, 0, 1, 0, 0.97, 0.93, 0.98, 0.01, 0.01, 0, 0, 0.2, 0.03, 0.06, 0.01, 0.02, 0.31, 0.13, 0.1, 0.34, 0.12,
      0.02, 0.04, 0.01, 0.97,
    ],
    probabilities: [
      0.00019687643147160618, 0.9949599216457975, 0.00006888890851570143, 0.003789652152086531, 0.0003935706062917658,
      0.0005910902558370784,
    ],
    expected: "quick",
  },
  {
    id: "prt_0a936b24a0019PN9llcWuLC30a",
    features: [
      1, 0, 0, 0, 0, 0, 0, 0.95, 0.92, 0, 0.01, 0.13, 0.81, 0.05, 0.08, 0.81, 0.91, 0.1, 0.02, 0, 0.01, 0.18, 0.81, 0,
      0.51, 0.72, 0.05, 0.97,
    ],
    probabilities: [
      0.07479770078001513, 0.00029999082973093547, 0.9144193327705064, 0.004382432078502738, 0.005785637964779926,
      0.0003149055764648167,
    ],
    expected: "unspecified-high",
  },
  {
    id: "prt_11a26a858001Qg7EPOH0G7VMBL",
    features: [
      0, 0.07, 0.33, 0.53, 0.06, 0.01, 0, 0.85, 0.57, 0.12, 0.74, 0.1, 0.03, 0.01, 0.08, 0.07, 0.07, 0.06, 0.06, 0.91,
      0.02, 0.04, 0.02, 0.01, 0.05, 0.04, 0.05, 0.3,
    ],
    probabilities: [
      0.00013574713696033264, 0.0009890367112680462, 0.0006494043595894932, 0.9930155277636004, 0.0047376272221588646,
      0.0004726568064228428,
    ],
    expected: "unspecified-low",
  },
  {
    id: "prt_1360e394e001AJArOiWPWI3Hd0",
    features: [
      0.04, 0, 0, 0, 0, 0, 0.96, 0.81, 0.82, 0, 0.25, 0.2, 0.52, 0.03, 0.15, 0.72, 0.59, 0.02, 0.01, 0, 0.64, 0.31, 0,
      0.05, 0.11, 0.39, 0.99, 0.58,
    ],
    probabilities: [
      0.0007483440681054157, 0.00001505650062314242, 0.001204746782067329, 0.0012509753232809314, 0.9967474750875772,
      0.00003340223834585618,
    ],
    expected: "visual-engineering",
  },
] as const

test.each(examples)("PG artifact matches parity example $id", (example) => {
  const ranking = inferJevCategory(example.features, PG_ROUTER)
  expect(ranking[0]?.category).toBe(example.expected)
  for (const [index, category] of PG_ROUTER.classes.entries()) {
    expect(ranking.find((row) => row.category === category)?.probability).toBeCloseTo(example.probabilities[index], 12)
  }
  expect(applyJevDecisionRule(ranking, PG_ARTIFACT.rule)).toBe(example.expected)
})

test.each(nonVisualVectors.map((vector) => ({ vector })))(
  "guarded artifact abstains on a confident non-visual saved vector",
  async ({ vector }) => {
    const parsed = parseJevCategoryResponse(categoryReply(vector), PG_ROUTER)
    expect(parsed.ranking[0]?.category).toBe("visual-engineering")
    await expect(
      Promise.resolve().then(() => applyJevDecisionRule(parsed.ranking, VISUAL_GUARDED_ARTIFACT.rule, parsed.answers)),
    ).rejects.toMatchObject({ name: "JevVisualDomainError", code: "domain_conflict" })
    expect(applyJevDecisionRule(parsed.ranking, PG_ARTIFACT.rule, parsed.answers)).toBe("visual-engineering")
  },
)

test.each(examples)("guarded artifact preserves parity control $expected", (example) => {
  const parsed = parseJevCategoryResponse(categoryReply(example.features), PG_ROUTER)
  expect(applyJevDecisionRule(parsed.ranking, VISUAL_GUARDED_ARTIFACT.rule, parsed.answers)).toBe(example.expected)
})

test.each([
  { frontend: 0, work: 0, expected: "domain_conflict" },
  { frontend: 0.3, work: 0.3, expected: "domain_conflict" },
  { frontend: 0.300001, work: 0.3, expected: "domain_uncertain" },
  { frontend: 0.3, work: 0.300001, expected: "domain_uncertain" },
  { frontend: 0.699999, work: 0.2, expected: "domain_uncertain" },
  { frontend: 0.5, work: 0.5, expected: "domain_uncertain" },
  { frontend: 0.7, work: 0, expected: "visual-engineering" },
  { frontend: 0, work: 0.7, expected: "visual-engineering" },
  { frontend: 0.7, work: 0.3, expected: "visual-engineering" },
  { frontend: 0.3, work: 0.7, expected: "visual-engineering" },
] as const)("visual evidence $frontend/$work produces $expected", async ({ frontend, work, expected }) => {
  const ranking = [{ category: "visual-engineering", probability: 1 }]
  const answers = {
    requires_frontend_ui_expertise: frontend,
    kind_of_work: Object.keys(questions().kind_of_work.criteria).map((option) =>
      option === "visual_ui" ? work : option === "code_change" ? 1 - work : 0,
    ),
  }
  switch (expected) {
    case "visual-engineering":
      expect(applyJevDecisionRule(ranking, VISUAL_GUARDED_ARTIFACT.rule, answers)).toBe(expected)
      break
    case "domain_conflict":
    case "domain_uncertain":
      await expect(
        Promise.resolve().then(() => applyJevDecisionRule(ranking, VISUAL_GUARDED_ARTIFACT.rule, answers)),
      ).rejects.toMatchObject({ code: expected })
      break
    default: {
      const exhaustive: never = expected
      throw new RangeError(`Unexpected visual outcome: ${exhaustive}`)
    }
  }
})

test("strong mass uses an inclusive threshold and preserves stronger ladder top-1", () => {
  for (const [mass, expected] of [
    [PG_RULE.threshold - 1e-12, "unspecified-low"],
    [PG_RULE.threshold, "deep-low"],
  ] as const) {
    expect(
      applyJevDecisionRule(
        [
          { category: "unspecified-low", probability: 1 - mass },
          { category: "deep-low", probability: mass },
        ],
        PG_RULE,
      ),
    ).toBe(expected)
  }
  expect(
    applyJevDecisionRule(
      [
        { category: "deep-high", probability: 0.6 },
        { category: "deep-low", probability: 0.4 },
      ],
      PG_RULE,
    ),
  ).toBe("deep-high")
  expect(
    applyJevDecisionRule(
      [
        { category: "unspecified-low", probability: 0.56 },
        { category: "visual-engineering", probability: 0.22 },
        { category: "deep-low", probability: 0.22 },
      ],
      PG_RULE,
    ),
  ).toBe("deep-low")
})

test("content identity selects refit by default and retains frozen rollback", () => {
  expect(selectJevArtifact()).toBe(PG_ARTIFACT)
  expect(PG_ARTIFACT.artifact_id).toBe("a8cb4f73e19f141fcf431239c8fd082f6fe8d52a139d1ba2ab108451f3427605")
  expect(selectJevArtifact(VISUAL_GUARDED_ARTIFACT.artifact_id)).toBe(VISUAL_GUARDED_ARTIFACT)
  expect(VISUAL_GUARDED_ARTIFACT.artifact_id).not.toBe(PG_ARTIFACT.artifact_id)
  expect(selectJevArtifact(ROLLBACK_ARTIFACT.artifact_id)).toBe(ROLLBACK_ARTIFACT)
  expect(PG_ARTIFACT.artifact_id).toMatch(/^[0-9a-f]{64}$/)
  expect(ROLLBACK_ARTIFACT.artifact_id).not.toBe(PG_ARTIFACT.artifact_id)
  expect(selectJevArtifact("unknown")).toBeUndefined()
})

test("configuration generation follows explicit category precedence and excludes descriptions", () => {
  const first = { quick: { model: "test/first", description: "First description" } }
  const second = { quick: { model: "test/second", description: "First description" } }
  expect(jevConfigGeneration(first, { userCategories: first, juniorModel: "test/default" })).not.toBe(
    jevConfigGeneration(second, { userCategories: second, juniorModel: "test/default" }),
  )
  expect(jevConfigGeneration(first)).toBe(
    jevConfigGeneration({ quick: { ...first.quick, description: "Other wording" } }),
  )
  expect(jevConfigGeneration(first)).not.toBe(
    jevConfigGeneration({ quick: { ...first.quick, fallback_models: ["test/fallback"] } }),
  )
})
