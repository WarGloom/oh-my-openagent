import { expect, spyOn, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TeamSpecSchema } from "@oh-my-opencode/team-core/types"
import { createRuntimeState } from "@oh-my-opencode/team-core/team-state-store/store"
import { TeamModeConfigSchema } from "../../config/schema/team-mode"
import { JevRoutingConfigSchema } from "../../config/schema/jev-routing"
import { provisionTeamMember } from "../../features/team-mode/team-runtime/provision-member"
import { clearTeamSessionRegistry } from "../../features/team-mode/team-session-registry"
import { bindAttemptSession, startAttempt } from "../../features/background-agent/attempt-lifecycle"
import type { BackgroundTask, LaunchInput } from "../../features/background-agent/types"
import * as providerCache from "../../shared/connected-providers-cache"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { categoryReply } from "./jev-router.test-support"
import * as ledger from "./jev-routing-ledger"

test("team provisioning joins the routed decision and reads briefs from the parent before child worktree dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "jev-team-"))
  const childDirectory = join(root, "child-worktree")
  mkdirSync(childDirectory)
  writeFileSync(join(root, "brief.md"), "Parent task brief")
  writeFileSync(join(childDirectory, "brief.md"), "Wrong child brief")
  const records: ledger.JevRoutingRecord[] = []
  const recordSpy = spyOn(ledger, "recordJevRouting").mockImplementation(async (record) => {
    records.push(record)
  })
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(categoryReply()))
  const cacheSpy = spyOn(providerCache, "readProviderModelsCache").mockReturnValue({
    connected: ["test"],
    models: { test: ["model"] },
    updatedAt: "2026-11-08",
  })
  const config = TeamModeConfigSchema.parse({ enabled: true, base_dir: join(root, "teams") })
  const member = {
    kind: "category" as const,
    name: "worker",
    category: "auto",
    prompt: "Read brief.md and implement the change",
  }
  let launched: LaunchInput | undefined
  let task: BackgroundTask | undefined
  const manager = {
    launch: async (input: LaunchInput) => {
      launched = input
      task = { ...input, id: "bg_team", status: "pending" }
      const attempt = startAttempt(task, input.model)
      bindAttemptSession(task, attempt.attemptId, "team-child", input.model)
      await input.onSessionCreated?.("team-child", input.model)
      return task
    },
    getTask: () => task,
  }
  try {
    const spec = TeamSpecSchema.parse({
      name: "routing",
      leadAgentId: "lead",
      members: [{ kind: "subagent_type", name: "lead", subagent_type: "sisyphus" }, member],
    })
    const state = await createRuntimeState(spec, "parent", "project", config, root)
    await provisionTeamMember({
      teamName: "routing",
      member,
      teamRunId: state.teamRunId,
      leadSessionId: "parent",
      config,
      ctx: unsafeTestValue({
        directory: childDirectory,
        manager,
        jevRouting: JevRoutingConfigSchema.parse({ mode: "active", default: "unspecified-low" }),
        userCategories: { "visual-engineering": { model: "test/model" }, "unspecified-low": { model: "test/model" } },
        client: {
          session: { get: async () => ({ data: { directory: root } }) },
          model: { list: async () => ({ data: [] }) },
        },
      }),
      bgMgr: unsafeTestValue(manager),
      roster: [],
      categoryExamples: "",
      parentMessageId: "message",
      deadlineAt: Date.now() + 5000,
    })
    const decision = records.find((record) => record.event === "decision")
    expect(decision).toMatchObject({
      surface: "team",
      parent_session_id: "parent",
      chosen_category: "visual-engineering",
    })
    expect(launched?.decisionId).toBe(decision?.decision_id)
    expect(
      records.find((record) => record.event === "attempt" && record.child_session_id === "team-child"),
    ).toMatchObject({ decision_id: decision?.decision_id, task_id: "bg_team" })
    expect(JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body).state.task.brief).toBe("Parent task brief")
    expect(JSON.stringify(records)).not.toContain(root)
    expect(JSON.stringify(records)).not.toContain("Parent task brief")
  } finally {
    recordSpy.mockRestore()
    fetchSpy.mockRestore()
    cacheSpy.mockRestore()
    clearTeamSessionRegistry()
    rmSync(root, { recursive: true, force: true })
  }
})
