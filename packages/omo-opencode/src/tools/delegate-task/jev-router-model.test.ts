import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { FROZEN_ROUTER, QUESTIONS_HASH, inferJevCategory, parseJevCategoryResponse } from "./jev-router-model"
import { categoryReply, frozenVectors } from "./jev-router.test-support"

describe("frozen Jev model contract", () => {
  test("question source retains the training hash", () => {
    const source = readFileSync(new URL("./jev-router-model.ts", import.meta.url), "utf8")
    const frozen = source.split("\n// Frozen model data")[0]
    expect(createHash("sha256").update(frozen).digest("hex")).toBe(QUESTIONS_HASH)
    expect(QUESTIONS_HASH).toBe("615db111c1a22545732d05b35a2c31fdb1b6445292e8861a90a8bcd526a39c75")
  })

  test.each(frozenVectors)("matches offline inference and answer encoding for $id", (fixture) => {
    const ranking = inferJevCategory(fixture.vector)
    const parsed = parseJevCategoryResponse(categoryReply(fixture.vector))
    expect(ranking[0]?.category).toBe(fixture.expected)
    for (const [index, category] of FROZEN_ROUTER.classes.entries()) {
      expect(ranking.find((row) => row.category === category)?.probability).toBeCloseTo(fixture.probabilities[index], 6)
    }
    expect(parsed.ranking).toEqual(ranking)
    expect(Object.keys(parsed.answers)).toHaveLength(14)
    expect(parsed.answers.kind_of_work).toEqual([
      fixture.vector[0],
      fixture.vector[2],
      fixture.vector[5],
      fixture.vector[1],
      fixture.vector[6],
      fixture.vector[4],
      fixture.vector[3],
    ])
    expect(parsed.answers.how_settled).toEqual(fixture.vector.slice(9, 14))
  })

  test.each([
    { ...categoryReply(), answers: {} },
    { ...categoryReply(), answers: { ...categoryReply().answers, extra: { type: "noul", noul: 0.5 } } },
    { ...categoryReply(), answers: { ...categoryReply().answers, owner_is_known: { type: "noul", noul: 1.2 } } },
    {
      ...categoryReply(),
      answers: {
        ...categoryReply().answers,
        how_settled: { type: "score", score: 2, confidence: 1, probabilities: { "0": 1 }, legend: {} },
      },
    },
    {
      ...categoryReply(),
      answers: {
        ...categoryReply().answers,
        scope: {
          type: "choice",
          choice: "single_file",
          confidence: 1,
          probabilities: {
            single_file: 1,
            one_module: 1,
            several_modules: 1,
            several_repositories_or_services: 1,
            administrative_not_applicable: 1,
          },
        },
      },
    },
  ])("rejects malformed response %#", (raw) => {
    expect(() => parseJevCategoryResponse(raw)).toThrow()
  })
})
