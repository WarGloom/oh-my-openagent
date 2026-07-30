/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import {
  addBoulderWork,
  createBoulderState,
  getBoulderFilePath,
  getWorkByPlanName,
  getWorkResumeOptions,
  normalizeSessionId,
  readBoulderState,
  writeBoulderState,
} from "../../features/boulder-state"
import type { BoulderWorkResumeOption } from "../../features/boulder-state"
import { parseSlashCommand } from "../auto-slash-command/detector"
import { buildExplicitPlanContext } from "./explicit-plan-context"
import { buildMultipleActiveWorksContext } from "./context-info-formatters"
import { parseUserRequest } from "./parse-user-request"

const SELECTION_BLOCK_START = "<start-work-selection-required>"
const SELECTION_BLOCK_END = "</start-work-selection-required>"

function createResumeOption(planName: string, worktreePath?: string): BoulderWorkResumeOption {
  return {
    work_id: `work-${planName}`,
    plan_name: planName,
    active_plan: `/plans/${planName}.md`,
    ...(worktreePath === undefined ? {} : { worktree_path: worktreePath }),
    status: "active",
    started_at: "2026-07-28T00:00:00.000Z",
    updated_at: "2026-07-28T00:00:00.000Z",
    session_count: 1,
    progress: { total: 2, completed: 1, isComplete: false },
    is_current_mirror: false,
  }
}

function extractSelectionCommands(context: string): readonly string[] {
  const blockStart = context.indexOf(SELECTION_BLOCK_START)
  const blockEnd = context.indexOf(SELECTION_BLOCK_END)
  if (blockStart < 0 || blockEnd <= blockStart) {
    return []
  }

  return context
    .slice(blockStart + SELECTION_BLOCK_START.length, blockEnd)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("/start-work "))
}

function parseGeneratedCommand(command: string) {
  const parsedCommand = parseSlashCommand(command)
  if (!parsedCommand) {
    throw new Error(`Invalid selection command: ${command}`)
  }

  return parseUserRequest(`<user-request>${parsedCommand.args}</user-request>`)
}

describe("multiple active start-work selection", () => {
  let testDirectory = ""

  function writePlan(worktreePath: string, planName: string): string {
    const plansDirectory = join(worktreePath, ".omo", "plans")
    mkdirSync(plansDirectory, { recursive: true })
    const planPath = join(plansDirectory, `${planName}.md`)
    writeFileSync(planPath, "## TODOs\n- [ ] 1. Execute selected work")
    return planPath
  }

  function createDuplicatePlanState(): readonly [string, string] {
    const firstWorktree = join(testDirectory, "worktree-a")
    const secondWorktree = join(testDirectory, "worktree-b")
    const firstPlan = writePlan(firstWorktree, "shared plan")
    const secondPlan = writePlan(secondWorktree, "shared plan")

    writeBoulderState(
      testDirectory,
      createBoulderState(firstPlan, "session-a", "atlas", firstWorktree),
    )
    addBoulderWork(testDirectory, {
      planPath: secondPlan,
      sessionId: "session-b",
      agent: "atlas",
      worktreePath: secondWorktree,
    })

    return [firstWorktree, secondWorktree]
  }

  beforeEach(() => {
    testDirectory = join(process.cwd(), ".tmp", `start-work-selection-${randomUUID()}`)
    mkdirSync(testDirectory, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testDirectory)) {
      rmSync(testDirectory, { recursive: true, force: true })
    }
  })

  test("#given multiple resume options #when context is formatted #then each option has a parseable explicit command", () => {
    // given
    const worktreePath = join(testDirectory, "worktree-with-plan")
    const resumeOptions = [
      createResumeOption("plan with whitespace", worktreePath),
      createResumeOption("plan without worktree"),
    ]

    // when
    const context = buildMultipleActiveWorksContext({
      resumeOptions,
      sessionId: "opencode:selection-session",
      timestamp: "2026-07-28T00:00:00.000Z",
    })
    const commands = extractSelectionCommands(context)

    // then
    expect(commands).toEqual([
      `/start-work "plan with whitespace" --worktree ${worktreePath}`,
      '/start-work "plan without worktree"',
    ])
    expect(parseGeneratedCommand(commands[0] ?? "")).toEqual({
      planName: "plan with whitespace",
      explicitWorktreePath: worktreePath,
      makePr: false,
      ship: false,
    })
    expect(parseGeneratedCommand(commands[1] ?? "")).toEqual({
      planName: "plan without worktree",
      explicitWorktreePath: null,
      makePr: false,
      ship: false,
    })
  })

  test("#given duplicate plan names in distinct worktrees #when each command follows up #then each work and session bind exactly", () => {
    // given
    const worktrees = createDuplicatePlanState()
    const resumeOptions = getWorkResumeOptions(testDirectory)
    const context = buildMultipleActiveWorksContext({
      resumeOptions,
      sessionId: "opencode:selection-session",
      timestamp: "2026-07-28T00:00:00.000Z",
    })
    const commands = extractSelectionCommands(context)

    // when
    for (const [index, worktreePath] of worktrees.entries()) {
      const command = commands.find((candidate) => candidate.endsWith(`--worktree ${worktreePath}`))
      if (!command) {
        throw new Error(`Missing selection command for option ${index + 1}`)
      }
      const request = parseGeneratedCommand(command)
      const sessionId = `followup-${index + 1}`
      buildExplicitPlanContext({
        explicitPlanName: request.planName ?? "",
        sessionId,
        timestamp: "2026-07-28T00:00:00.000Z",
        activeAgent: "atlas",
        worktreePath: request.explicitWorktreePath ?? undefined,
        worktreeBlock: "",
        directory: testDirectory,
      })

      // then
      const selectedWork = getWorkByPlanName(testDirectory, "shared plan", { worktreePath })
      const selectedState = readBoulderState(testDirectory)
      expect(selectedWork?.session_ids).toContain(normalizeSessionId(sessionId))
      expect(selectedState?.active_work_id).toBe(selectedWork?.work_id)
    }

    expect(new Set(commands).size).toBe(2)
  })

  test("#given persisted multiple works #when selection context is formatted #then Boulder state is unchanged", () => {
    // given
    createDuplicatePlanState()
    const boulderFilePath = getBoulderFilePath(testDirectory)
    const before = readFileSync(boulderFilePath, "utf8")

    // when
    buildMultipleActiveWorksContext({
      resumeOptions: getWorkResumeOptions(testDirectory),
      sessionId: "opencode:selection-session",
      timestamp: "2026-07-28T00:00:00.000Z",
    })

    // then
    expect(readFileSync(boulderFilePath, "utf8")).toBe(before)
  })
})
