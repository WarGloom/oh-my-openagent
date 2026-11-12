import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  watch,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JevRoutingConfigSchema } from "../../config/schema/jev-routing"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { createDelegateTask } from "./tools"
import { getJevLedgerDirectory } from "./jev-routing-ledger"
import { categoryReply } from "./jev-router.test-support"
import { resolveCategoryExecution } from "./category-resolver"
import { resolveMember } from "../../features/team-mode/team-runtime/resolve-member"
import * as providerCache from "../../shared/connected-providers-cache"
import type { ExecutorContext } from "./executor-types"
import { bindAttemptSession, startAttempt } from "../../features/background-agent/attempt-lifecycle"
import type { BackgroundTask, LaunchInput } from "../../features/background-agent/types"
import * as ledger from "./jev-routing-ledger"

describe("Jev task dispatch", () => {
  let root: string
  let fetchSpy: ReturnType<typeof spyOn>
  let cacheSpy: ReturnType<typeof spyOn>
  let recordSpy: ReturnType<typeof spyOn>
  const oldData = process.env.XDG_DATA_HOME
  const categories = {
    "visual-engineering": { models: ["example/visual", "other/backup"] },
    "unspecified-low": { models: ["example/default"] },
  }
  const routing = JevRoutingConfigSchema.parse({ mode: "active", default: "unspecified-low" })
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jev-dispatch-"))
    process.env.XDG_DATA_HOME = root
    recordSpy = spyOn(ledger, "recordJevRouting")
    mkdirSync(getJevLedgerDirectory(), { recursive: true })
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(categoryReply()))
    cacheSpy = spyOn(providerCache, "readProviderModelsCache").mockReturnValue({
      connected: ["example", "other"],
      models: { example: ["visual", "default"], other: ["backup"] },
      updatedAt: "2026-11-08",
    })
  })
  afterEach(async () => {
    await Promise.all(recordSpy.mock.results.map((result) => (result.type === "return" ? result.value : undefined)))
    recordSpy.mockRestore()
    fetchSpy.mockRestore()
    cacheSpy.mockRestore()
    if (oldData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = oldData
    rmSync(root, { recursive: true, force: true })
  })

  function ledgerRows() {
    return readdirSync(getJevLedgerDirectory())
      .filter((name) => name.endsWith(".jsonl"))
      .flatMap((name) =>
        readFileSync(join(getJevLedgerDirectory(), name), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      )
  }
  function watchRecords(count: number) {
    const pending = Promise.withResolvers<ReturnType<typeof ledgerRows>>()
    const timer = setTimeout(() => pending.reject(new Error(`Missing ${count} routing records`)), 5000)
    const watcher = watch(getJevLedgerDirectory(), () => {
      const rows = ledgerRows()
      if (rows.length === count) pending.resolve(rows)
    })
    return {
      promise: pending.promise,
      close() {
        watcher.close()
        clearTimeout(timer)
      },
    }
  }
  function setup(mode: "active" | "observe" | "off" = "active", native = false) {
    const launch = mock(async (input: LaunchInput) => {
      const task: BackgroundTask = { ...input, id: "bg_worker", status: "pending" }
      const attempt = startAttempt(task, input.model)
      bindAttemptSession(task, attempt.attemptId, "ses_worker", input.model)
      return task
    })
    const client = {
      model: { list: async () => ({ data: [] }) },
      config: { get: async () => ({ data: {} }) },
      session: { get: async () => ({ data: { directory: root } }), messages: async () => ({ data: [] }) },
    }
    const options = {
      manager: { launch, ...(native ? { nativeJobs: {} } : {}) },
      client,
      directory: root,
      userCategories: categories,
      jevRouting: { ...routing, mode },
    }
    const delegate = createDelegateTask(unsafeTestValue(options))
    const ctx = unsafeTestValue<Parameters<typeof delegate.execute>[1]>({
      callID: "call_1",
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "sisyphus",
      abort: new AbortController().signal,
    })
    return { launch, delegate, ctx, options }
  }

  test("rejects an exact model with no eligible category before classifier or child launch", async () => {
    const { delegate, ctx, launch } = setup("active", true)
    await expect(
      delegate.execute(
        {
          ...{ required_model: "example/specialist" },
          category: "auto",
          prompt: "Review the sanitized fixture",
          run_in_background: true,
          load_skills: [],
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "executor_requirement", reason: "no_eligible_executor" })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
  })

  test.each([
    { mode: "active" },
    { mode: "observe" },
    { mode: "off" },
    { mode: "active", model_routing: false },
    { mode: "active", offline: true },
    { mode: "active", roundRobin: true },
  ] as const)("keeps an exact model binding in $mode routing ($model_routing, $offline)", async (selection) => {
    const { delegate, ctx, launch, options } = setup(selection.mode, true)
    const category = `round-robin-${crypto.randomUUID()}`
    const rr = {
      ...options,
      userCategories: {
        ...categories,
        [category]: { models: ["example/visual", "example/default"], models_distribution: "round_robin" },
      },
    }
    const selected = "roundRobin" in selection ? createDelegateTask(unsafeTestValue(rr)) : delegate
    if ("offline" in selection) fetchSpy.mockRejectedValue(new Error("offline"))
    await selected.execute(
      {
        ...{ required_model: "example/default" },
        category: "auto",
        prompt: "Review the sanitized fixture",
        model_routing: "model_routing" in selection ? selection.model_routing : undefined,
        run_in_background: true,
        load_skills: [],
      },
      ctx,
    )
    expect(launch).toHaveBeenCalledTimes(1)
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "unspecified-low",
        model: expect.objectContaining({ providerID: "example", modelID: "default" }),
        nativeMetadata: { requiredModel: "example/default" },
        fallbackChain: [],
      }),
    )
    if ("roundRobin" in selection)
      expect(
        (
          await resolveCategoryExecution(
            { category, prompt: "work", description: "work", load_skills: [], run_in_background: false },
            unsafeTestValue<ExecutorContext>({ ...rr, jevRouting: undefined }),
            undefined,
            undefined,
          )
        ).categoryModel?.modelID,
      ).toBe("visual")
  })

  test("rejects a category that would replace a required registered agent", async () => {
    const { delegate, ctx, launch } = setup("active", true)
    await expect(
      delegate.execute(
        {
          category: "auto",
          subagent_type: "registered-specialist",
          prompt: "Review the sanitized fixture",
          run_in_background: true,
          load_skills: [],
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "executor_requirement", reason: "agent_conflict" })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
  })

  test.each([undefined, "auto"])("routes category %s through top-1 and joins the child dispatch", async (category) => {
    const { delegate, ctx, launch } = setup()
    const watched = watchRecords(3)
    try {
      const output = await delegate.execute(
        { category, prompt: "Implement the feature", description: "Feature", run_in_background: true, load_skills: [] },
        ctx,
      )
      expect(output).not.toContain("Routing: Jev unavailable")
      expect(launch).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "visual-engineering",
          model: expect.objectContaining({ modelID: "visual" }),
        }),
      )
      const rows = await watched.promise
      const decision = rows.find((row) => row.event === "decision")
      expect(decision).toMatchObject({
        orchestrator_category: category ?? "omitted",
        chosen_category: "visual-engineering",
        mode: "active",
        parent_session_id: "ses_parent",
        top1: { category: "visual-engineering" },
      })
      expect(rows.find((row) => row.event === "attempt" && row.child_session_id === "ses_worker")).toMatchObject({
        decision_id: decision.decision_id,
        task_id: "bg_worker",
        cause: "initial",
      })
    } finally {
      watched.close()
    }
  })

  test("reports when an unavailable router uses the configured default", async () => {
    const { delegate, ctx, launch } = setup()
    fetchSpy.mockRejectedValue(new Error("offline"))
    const output = await delegate.execute(
      { prompt: "Implement feature", run_in_background: true, load_skills: [] },
      ctx,
    )
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ category: "unspecified-low" }))
    expect(output).toContain("Routing: Jev unavailable (unavailable); used default unspecified-low.")
  })

  test.each(["missing", "outside_root", "symlink", "unreadable", "not_regular", "oversized"] as const)(
    "rejects active %s briefs before task or team selection",
    async (reason) => {
      const path = join(root, "brief.md")
      let reference = "brief.md"
      switch (reason) {
        case "missing":
          break
        case "outside_root":
          reference = "../private-plan.md"
          break
        case "symlink":
          writeFileSync(join(root, "target.md"), "PRIVATE CONTENT")
          symlinkSync(join(root, "target.md"), path)
          break
        case "unreadable":
          writeFileSync(path, "PRIVATE CONTENT")
          chmodSync(path, 0)
          break
        case "not_regular":
          mkdirSync(path)
          break
        case "oversized":
          writeFileSync(path, "x".repeat(1024 * 1024 + 1))
          break
        default: {
          const exhaustive: never = reason
          throw new RangeError(`Unexpected brief reason: ${exhaustive}`)
        }
      }
      const { delegate, ctx, launch, options } = setup()
      const prompt = `Read ${reference} and implement the change`
      const watched = watchRecords(2)
      try {
        await expect(
          delegate.execute({ category: "auto", prompt, run_in_background: true, load_skills: [] }, ctx),
        ).rejects.toMatchObject({ name: "JevIncompleteInputError" })
        await expect(
          resolveMember(
            unsafeTestValue({ kind: "category", name: "worker", category: "auto", prompt }),
            unsafeTestValue<ExecutorContext>({ ...options, jevSurface: "team" }),
            "",
          ),
        ).rejects.toThrow("Provide the permitted brief inline or choose an explicit category or agent")
        const rows = await watched.promise
        expect(rows).toHaveLength(2)
        expect(rows.map((row) => row.surface).sort()).toEqual(["task", "team"])
        for (const row of rows)
          expect(row).toMatchObject({
            event: "decision",
            error: "incomplete_input",
            chosen_category: null,
            top1: null,
            answers: null,
            jev_model_id: null,
            brief_status: "unresolved",
            would_block: true,
            reason_codes: ["referenced_brief_unresolved", reason],
          })
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(launch).not.toHaveBeenCalled()
      } finally {
        watched.close()
      }
    },
  )

  test.each(["resolved", "inline"])("routes complete %s briefs normally", async (kind) => {
    writeFileSync(join(root, "brief.md"), "Implement the bounded change")
    const { delegate, ctx, launch } = setup()
    await delegate.execute(
      {
        prompt: kind === "resolved" ? "Read brief.md and implement the change" : "Implement the bounded change",
        run_in_background: true,
        load_skills: [],
      },
      ctx,
    )
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ category: "visual-engineering" }))
  })

  test.each([
    { mode: "active", category: "unspecified-low" },
    { mode: "observe", category: "auto" },
    { mode: "off", category: "unspecified-low" },
    { mode: "active", category: "auto", model_routing: false },
  ] as const)(
    "preserves $mode category $category authority for an unresolved brief",
    async ({ mode, ...selection }) => {
      const { delegate, ctx, launch } = setup(mode)
      const output = await delegate.execute(
        { ...selection, prompt: "Read missing-plan.md", run_in_background: true, load_skills: [] },
        ctx,
      )
      expect(launch).toHaveBeenCalledWith(expect.objectContaining({ category: "unspecified-low" }))
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(output).not.toContain("Routing: Jev unavailable")
    },
  )

  test("mode off preserves the omitted-selection error without a classifier request", async () => {
    const { delegate, ctx, launch } = setup("off")
    const result = await delegate.execute(
      { prompt: "Implement feature", run_in_background: true, load_skills: [] },
      ctx,
    )
    expect(result).toContain("Must provide either category or subagent_type")
    expect(launch).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test("omitted category without a valid routing default retains the explicit-selection error", async () => {
    const { ctx, options, launch } = setup()
    const delegate = createDelegateTask(unsafeTestValue({ ...options, jevRouting: { ...routing, default: undefined } }))
    const result = await delegate.execute(
      { prompt: "Implement feature", run_in_background: true, load_skills: [] },
      ctx,
    )
    expect(result).toContain("Must provide either category or subagent_type")
    expect(launch).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test("an explicit category dispatches before the pending classifier and records both choices", async () => {
    const response = Promise.withResolvers<Response>()
    fetchSpy.mockReturnValue(response.promise)
    const { delegate, ctx, launch } = setup()
    const watched = watchRecords(3)
    try {
      await delegate.execute(
        { category: "unspecified-low", prompt: "Implement feature", run_in_background: true, load_skills: [] },
        ctx,
      )
      expect(launch).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "unspecified-low",
          model: expect.objectContaining({ modelID: "default" }),
        }),
      )
      response.resolve(Response.json(categoryReply()))
      const rows = await watched.promise
      expect(rows.find((row) => row.event === "decision")).toMatchObject({
        orchestrator_category: "unspecified-low",
        chosen_category: "unspecified-low",
        mode: "observe",
        top1: { category: "visual-engineering" },
        error: null,
      })
    } finally {
      watched.close()
    }
  })

  test("observe auto dispatches the default while recording the model opinion", async () => {
    const { delegate, ctx, launch } = setup("observe")
    const watched = watchRecords(3)
    try {
      await delegate.execute({ prompt: "Implement feature", run_in_background: true, load_skills: [] }, ctx)
      expect(launch).toHaveBeenCalledWith(expect.objectContaining({ category: "unspecified-low" }))
      expect((await watched.promise).find((row) => row.event === "decision")).toMatchObject({
        chosen_category: "unspecified-low",
        mode: "observe",
        top1: { category: "visual-engineering" },
      })
    } finally {
      watched.close()
    }
  })

  test("malformed inference records its error and dispatches the default", async () => {
    fetchSpy.mockResolvedValue(Response.json({ answers: {} }))
    const { delegate, ctx, launch } = setup()
    const watched = watchRecords(3)
    try {
      await delegate.execute({ prompt: "Implement feature", run_in_background: true, load_skills: [] }, ctx)
      expect(launch).toHaveBeenCalledWith(expect.objectContaining({ category: "unspecified-low" }))
      expect((await watched.promise).find((row) => row.event === "decision")).toMatchObject({
        chosen_category: "unspecified-low",
        error: "malformed",
        top1: null,
      })
    } finally {
      watched.close()
    }
  })

  test("category resolution retains the full cross-provider fallback chain and category team wiring", async () => {
    const { options } = setup()
    const context = unsafeTestValue<ExecutorContext>(options)
    const args = {
      category: "auto",
      prompt: "Implement feature",
      description: "Feature",
      run_in_background: false,
      load_skills: [],
    }
    const result = await resolveCategoryExecution(args, context, undefined, undefined)
    expect(args.category).toBe("visual-engineering")
    expect(result.actualModel).toBe("example/visual")
    const explicit = await resolveCategoryExecution(
      { ...args, category: "visual-engineering" },
      { ...context, jevRouting: { ...routing, mode: "off" } },
      undefined,
      undefined,
    )
    expect(result.fallbackChain).toEqual(explicit.fallbackChain)
    expect(result.fallbackChain?.[0]).toMatchObject({ providers: ["other"], model: "backup" })
    const member = await resolveMember(
      unsafeTestValue({ kind: "category", name: "worker", category: "auto", prompt: "Implement feature" }),
      context,
      "",
    )
    expect(member.category).toBe("visual-engineering")
    expect(member.model).toMatchObject({ providerID: "example", modelID: "visual" })
    const request = fetchSpy.mock.calls.at(-1)?.[1]
    const body = JSON.parse(String(request?.body))
    expect(body.state.task.title).toBe("worker: Implement feature")
    expect(body.state.task.prompt).toBe("Implement feature")
  })

  test("a stalled parent directory lookup falls back within the routing timeout", async () => {
    const { options } = setup()
    const client = { ...options.client, session: { ...options.client.session, get: () => new Promise(() => {}) } }
    const context = unsafeTestValue<ExecutorContext>({
      ...options,
      client,
      jevRouting: { ...routing, timeout_ms: 100 },
      jevParentSessionID: "ses_parent",
    })
    const args = {
      category: "auto",
      prompt: "Implement feature",
      description: "Feature",
      run_in_background: false,
      load_skills: [],
    }
    const result = await resolveCategoryExecution(args, context, undefined, undefined)
    expect(args.category).toBe("unspecified-low")
    expect(result.routingNotice).toContain("unavailable")
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
