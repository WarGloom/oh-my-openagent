import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JevRoutingConfigSchema } from "../../config/schema/jev-routing"
import { routeCategoryWithJev } from "./jev-category-routing"
import { OPTIONS, questions } from "./jev-router-model"
import {
  ALL_CATEGORIES_ARTIFACT,
  ALL_CATEGORIES_RULE,
  PG_ARTIFACT,
  PG_ROUTER,
  VISUAL_GUARDED_ARTIFACT,
  applyJevDecisionRule,
  listJevArtifactCategories,
  selectJevArtifact,
} from "./jev-router-artifacts"
import { categoryReply, nonVisualVectors } from "./jev-router.test-support"
import * as ledger from "./jev-routing-ledger"

type Work = (typeof OPTIONS)[number]
const creativeQuestion = ALL_CATEGORIES_RULE.open_decision.creative_question
const mainWorkQuestion = ALL_CATEGORIES_RULE.visual_domain.main_work_question
const threshold = ALL_CATEGORIES_RULE.open_decision.threshold

function answers(open: number, work: Work, creative = 0, frontend = 0, mainUi = 0) {
  return {
    how_settled: [0, 0, 0, 1 - open, open],
    kind_of_work: OPTIONS.map((option) => (option === work ? 1 : 0)),
    requires_frontend_ui_expertise: frontend,
    [creativeQuestion]: creative,
    [mainWorkQuestion]: mainUi,
  }
}
const routine = [
  { category: "unspecified-low", probability: 0.9 },
  { category: "deep-low", probability: 0.1 },
]
const visual = [
  { category: "visual-engineering", probability: 0.9 },
  { category: "unspecified-low", probability: 0.1 },
]

describe("all-categories decision rule", () => {
  test.each([
    { open: threshold, work: "code_change", creative: 0, expected: "deep-high" },
    { open: 0.5, work: "investigation_only", creative: 0, expected: "ultrabrain" },
    { open: 0.5, work: "review_judgment", creative: 0.69, expected: "ultrabrain" },
    { open: 0.5, work: "code_change", creative: 0.7, expected: "artistry" },
    { open: threshold - 0.01, work: "code_change", creative: 0.9, expected: "unspecified-low" },
  ] as const)("open decision $open with $work and creative $creative selects $expected", (row) => {
    // given: a routine classifier ranking and the stated answers
    // when: the rule decides
    // then: only an open central decision escalates
    expect(
      applyJevDecisionRule(routine, ALL_CATEGORIES_ARTIFACT.rule, answers(row.open, row.work, row.creative)),
    ).toBe(row.expected)
  })

  test("positive visual evidence wins over an open decision", () => {
    expect(applyJevDecisionRule(visual, ALL_CATEGORIES_ARTIFACT.rule, answers(0.9, "visual_ui", 0, 0.9, 0.9))).toBe(
      "visual-engineering",
    )
  })

  test.each([
    { frontend: 0.95, mainUi: 0.49, work: "code_change", expected: "unspecified-low" },
    { frontend: 0.95, mainUi: 0.5, work: "review_judgment", expected: "visual-engineering" },
    { frontend: 0.1, mainUi: 0.9, work: "code_change", expected: "visual-engineering" },
  ] as const)(
    "a visual top class with frontend $frontend and UI share $mainUi selects $expected",
    ({ frontend, mainUi, work, expected }) => {
      // given: the classifier ranks visual first and the decision is settled
      // when: the answer about UI being the main work decides whether the task is visual
      // then: a task that merely touches UI code takes the next class, and a UI review stays visual
      expect(
        applyJevDecisionRule(visual, ALL_CATEGORIES_ARTIFACT.rule, answers(0, work, 0, frontend, mainUi)),
      ).toBe(expected)
    },
  )

  test("a mixed task with an open decision escalates before it takes the next class", () => {
    expect(applyJevDecisionRule(visual, ALL_CATEGORIES_ARTIFACT.rule, answers(0.5, "code_change", 0, 0.95))).toBe(
      "deep-high",
    )
  })

  test("the earlier visual guard still accepts frontend expertise alone", () => {
    expect(applyJevDecisionRule(visual, VISUAL_GUARDED_ARTIFACT.rule, answers(0, "code_change", 0, 0.95))).toBe(
      "visual-engineering",
    )
  })

  test("a visual selection without visual evidence escalates instead of abstaining", () => {
    expect(applyJevDecisionRule(visual, ALL_CATEGORIES_ARTIFACT.rule, answers(0.5, "investigation_only"))).toBe(
      "ultrabrain",
    )
  })

  test("a visual selection without visual evidence still abstains when the decision is settled", async () => {
    await expect(
      Promise.resolve().then(() =>
        applyJevDecisionRule(visual, ALL_CATEGORIES_ARTIFACT.rule, answers(0.1, "investigation_only")),
      ),
    ).rejects.toMatchObject({ code: "domain_conflict" })
  })

  test("a missing creative answer is rejected", () => {
    const { [creativeQuestion]: _omitted, ...incomplete } = answers(0.5, "code_change")
    expect(() => applyJevDecisionRule(routine, ALL_CATEGORIES_ARTIFACT.rule, incomplete)).toThrow(RangeError)
  })

  test("the artifact is selectable and leaves the earlier artifact identities unchanged", () => {
    expect(selectJevArtifact(ALL_CATEGORIES_ARTIFACT.artifact_id)).toBe(ALL_CATEGORIES_ARTIFACT)
    expect(PG_ARTIFACT.artifact_id).toBe("a8cb4f73e19f141fcf431239c8fd082f6fe8d52a139d1ba2ab108451f3427605")
    expect(VISUAL_GUARDED_ARTIFACT.artifact_id).toBe("1a019c1e19941b430e4f8f3ac4989eac913367cb2710bf33a6bb6d73382aa307")
    expect(listJevArtifactCategories(VISUAL_GUARDED_ARTIFACT)).toEqual([...PG_ROUTER.classes])
    expect(listJevArtifactCategories(ALL_CATEGORIES_ARTIFACT)).toEqual([
      ...PG_ROUTER.classes,
      "deep-high",
      "ultrabrain",
      "artistry",
    ])
  })
})

describe("all-categories routing", () => {
  const oldData = process.env.XDG_DATA_HOME
  const config = JevRoutingConfigSchema.parse({
    mode: "active",
    default: "unspecified-low",
    artifact_id: ALL_CATEGORIES_ARTIFACT.artifact_id,
  })
  const enabledCategories = { "unspecified-low": {}, "visual-engineering": {}, "deep-high": {}, ultrabrain: {} }
  const openDecision = [0, 0, 0, 0.4, 0.6]
  const reply = categoryReply(
    nonVisualVectors[0].map((value, index) => {
      const level = /^jev\.how_settled\.(\d)$/.exec(PG_ROUTER.features[index])?.[1]
      return level === undefined ? value : openDecision[Number(level)]
    }),
  )
  let directory: string
  let fetchSpy: ReturnType<typeof spyOn>
  let ledgerSpy: ReturnType<typeof spyOn>
  let records: ledger.JevRoutingRecord[]
  const fallback = mock(() => {})
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "jev-all-categories-"))
    process.env.XDG_DATA_HOME = directory
    records = []
    fallback.mockClear()
    ledgerSpy = spyOn(ledger, "recordJevRouting").mockImplementation((record) => {
      records.push(record)
      return Promise.resolve()
    })
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        ...reply,
        answers: {
          ...reply.answers,
          [creativeQuestion]: { type: "noul", noul: 0.1 },
          [mainWorkQuestion]: { type: "noul", noul: 0.05 },
        },
      }),
    )
  })
  afterEach(() => {
    fetchSpy.mockRestore()
    ledgerSpy.mockRestore()
    if (oldData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = oldData
    rmSync(directory, { recursive: true, force: true })
  })
  const input = () => ({
    brief: "Choose the cancellation guarantee across both services",
    directory,
    config,
    enabledCategories,
    onFallback: fallback,
  })

  test("asks the extra question, escalates and records its answer", async () => {
    // given: an implementation brief whose central decision is open
    // when: auto routing runs with the all-categories artifact
    expect(await routeCategoryWithJev(input())).toBe("deep-high")
    // then: the request carries the frozen questions plus the artifact's question
    const asked = Object.keys(JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body).questions)
    expect(asked).toEqual([...Object.keys(questions()), creativeQuestion, mainWorkQuestion])
    const decision = records[0]
    if (!decision || decision.event !== "decision") throw new RangeError("Missing routing decision")
    expect(decision).toMatchObject({
      chosen_category: "deep-high",
      error: null,
      artifact_id: ALL_CATEGORIES_ARTIFACT.artifact_id,
    })
    expect(decision.answers?.[creativeQuestion]).toBe(0.1)
    await ledger.appendJevRoutingRecord(decision)
    expect(fallback).not.toHaveBeenCalled()
  })

  test("a response without the extra answer falls back as malformed", async () => {
    fetchSpy.mockResolvedValue(Response.json(reply))
    expect(await routeCategoryWithJev(input())).toBe("unspecified-low")
    expect(records[0]).toMatchObject({ chosen_category: "unspecified-low", error: "malformed" })
    expect(fallback).toHaveBeenCalledWith("malformed", "unspecified-low")
  })

  test("an earlier artifact sends only the frozen questions", async () => {
    fetchSpy.mockResolvedValue(Response.json(categoryReply()))
    await routeCategoryWithJev({
      ...input(),
      config: { ...config, artifact_id: VISUAL_GUARDED_ARTIFACT.artifact_id },
    })
    expect(Object.keys(JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body).questions)).toEqual(Object.keys(questions()))
  })
})
