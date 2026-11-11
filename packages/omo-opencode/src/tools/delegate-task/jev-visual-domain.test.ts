import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JevRoutingConfigSchema } from "../../config/schema/jev-routing"
import { routeCategoryWithJev } from "./jev-category-routing"
import { PG_ARTIFACT, PG_ROUTER, VISUAL_GUARDED_ARTIFACT } from "./jev-router-artifacts"
import { categoryReply, nonVisualVectors } from "./jev-router.test-support"
import * as ledger from "./jev-routing-ledger"

describe("guarded visual routing", () => {
  const oldData = process.env.XDG_DATA_HOME
  const config = JevRoutingConfigSchema.parse({
    mode: "active",
    default: "unspecified-low",
    artifact_id: VISUAL_GUARDED_ARTIFACT.artifact_id,
  })
  const enabledCategories = { "unspecified-low": {}, "visual-engineering": {}, writing: {} }
  let directory: string
  let fetchSpy: ReturnType<typeof spyOn>
  let ledgerSpy: ReturnType<typeof spyOn>
  let records: ledger.JevRoutingRecord[]
  const fallback = mock(() => {})
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "jev-visual-"))
    process.env.XDG_DATA_HOME = directory
    records = []
    fallback.mockClear()
    ledgerSpy = spyOn(ledger, "recordJevRouting").mockImplementation((record) => {
      records.push(record)
      return Promise.resolve()
    })
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(categoryReply(nonVisualVectors[0])))
  })
  afterEach(() => {
    fetchSpy.mockRestore()
    ledgerSpy.mockRestore()
    if (oldData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = oldData
    rmSync(directory, { recursive: true, force: true })
  })
  const input = () => ({
    brief: "Implement the supplied backend change",
    directory,
    config,
    enabledCategories,
    onFallback: fallback,
  })

  test.each([
    { frontend: 0.12, code: "domain_conflict" },
    { frontend: 0.5, code: "domain_uncertain" },
  ] as const)("active $code retains raw inference and rejects before fallback", async ({ frontend, code }) => {
    const vector = nonVisualVectors[0].map((value, index) =>
      PG_ROUTER.features[index] === "jev.requires_frontend_ui_expertise" ? frontend : value,
    )
    fetchSpy.mockResolvedValue(Response.json(categoryReply(vector)))
    await expect(routeCategoryWithJev(input())).rejects.toMatchObject({ name: "JevVisualDomainError", code })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      event: "decision",
      mode: "active",
      chosen_category: null,
      error: code,
      artifact_id: VISUAL_GUARDED_ARTIFACT.artifact_id,
      top1: { category: "visual-engineering" },
      jev_model_id: "jev-1.14.0",
      would_block: true,
      reason_codes: [code],
    })
    const decision = records[0]
    if (!decision || decision.event !== "decision") throw new RangeError("Missing routing decision")
    expect(decision.answers?.requires_frontend_ui_expertise).toBe(frontend)
    await ledger.appendJevRoutingRecord(decision)
    expect(fallback).not.toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test.each(["writing", "visual-engineering"])(
    "explicit %s selection retains authority and observed raw judgment",
    async (orchestratorCategory) => {
      expect(await routeCategoryWithJev({ ...input(), orchestratorCategory })).toBe(orchestratorCategory)
      expect(records[0]).toMatchObject({
        chosen_category: orchestratorCategory,
        mode: "observe",
        error: "domain_conflict",
        top1: { category: "visual-engineering" },
        would_block: true,
      })
      expect(fallback).not.toHaveBeenCalled()
    },
  )

  test("observe auto keeps the default and records domain conflict without fallback", async () => {
    expect(await routeCategoryWithJev({ ...input(), config: { ...config, mode: "observe" } })).toBe("unspecified-low")
    expect(records[0]).toMatchObject({
      chosen_category: "unspecified-low",
      mode: "observe",
      error: "domain_conflict",
      would_block: true,
    })
    expect(fallback).not.toHaveBeenCalled()
  })

  test("eligible visual evidence keeps execution eligible", async () => {
    fetchSpy.mockResolvedValue(Response.json(categoryReply()))
    expect(await routeCategoryWithJev(input())).toBe("visual-engineering")
    expect(records[0]).toMatchObject({
      chosen_category: "visual-engineering",
      error: null,
      would_block: false,
      artifact_id: VISUAL_GUARDED_ARTIFACT.artifact_id,
    })
  })

  test("an explicit legacy artifact preserves the old visual decision", async () => {
    expect(
      await routeCategoryWithJev({ ...input(), config: { ...config, artifact_id: PG_ARTIFACT.artifact_id } }),
    ).toBe("visual-engineering")
    expect(records[0]).toMatchObject({
      chosen_category: "visual-engineering",
      error: null,
      artifact_id: PG_ARTIFACT.artifact_id,
    })
  })

  test.each(["off", "bypass"] as const)("%s keeps its existing default without inference", async (mode) => {
    const request =
      mode === "off" ? { ...input(), config: { ...config, mode } } : { ...input(), modelRouting: false as const }
    expect(await routeCategoryWithJev(request)).toBe("unspecified-low")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test.each([
    { response: () => new Response(null, { status: 503 }), error: "http_error" },
    { response: () => Response.json({ answers: {} }), error: "malformed" },
    { response: () => Response.json({ ...categoryReply(), model: "unexpected-model" }), error: "model_mismatch" },
    {
      response: () =>
        Response.json({
          ...categoryReply(),
          answers: { ...categoryReply().answers, requires_frontend_ui_expertise: { type: "noul", noul: null } },
        }),
      error: "malformed",
    },
  ])("$error retains transport/parser fallback", async ({ response, error }) => {
    fetchSpy.mockResolvedValue(response())
    expect(await routeCategoryWithJev(input())).toBe("unspecified-low")
    expect(records[0]).toMatchObject({ chosen_category: "unspecified-low", error })
    expect(fallback).toHaveBeenCalledWith(error, "unspecified-low")
  })

  test("cancellation after a response remains cancellation rather than domain conflict", async () => {
    const response = Promise.withResolvers<Response>()
    const entered = Promise.withResolvers<void>()
    fetchSpy.mockImplementation(() => {
      entered.resolve()
      return response.promise
    })
    const controller = new AbortController()
    const pending = routeCategoryWithJev({ ...input(), signal: controller.signal })
    await entered.promise
    controller.abort()
    response.resolve(Response.json(categoryReply(nonVisualVectors[0])))
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(records[0]).toMatchObject({ error: "cancelled" })
    expect(fallback).not.toHaveBeenCalled()
  })
})
