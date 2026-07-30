/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { computeView, viewKey } from "./compute-view"
import { deriveAgents, deriveConfig, deriveCurrentSessionJobs, deriveLoop, deriveRoster, deriveTeams } from "./derivers"
import { MAX_AGENTS, MAX_JOBS, MIRROR_SCHEMA_VERSION, STALE_MS } from "./constants"
import { canonicalProjectDir, mirrorStorageDir } from "./mirror-path"
import { writeSessionJobsMirror } from "./session-jobs-mirror"
import type { TuiRuntimeSnapshot } from "./snapshot-schema"
import type { AgentRow, JobBoardState, JobRow, LoopLive, RosterRow, TeamRow } from "./state-types"

const liveLoop: LoopLive = {
  kind: "live",
  goalsDone: 2,
  goalsTotal: 5,
  pass: 3,
  fail: 1,
  pending: 4,
  blocked: 2,
  activeGoal: "Ship sidebar",
}

function snapshot(input: {
  readonly activeAgents?: readonly AgentRow[]
  readonly loop?: LoopLive | null
  readonly teams?: readonly TeamRow[]
}): TuiRuntimeSnapshot {
  return {
    version: MIRROR_SCHEMA_VERSION,
    projectDir: "/tmp/project",
    updatedAt: 1,
    activeAgents: [...(input.activeAgents ?? [])],
    loop: input.loop ?? null,
    teams: [...(input.teams ?? [])],
  }
}

function descendingRosterRows(count: number): readonly RosterRow[] {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = count - index - 1
    return {
      label: `Agent ${String(ordinal).padStart(2, "0")}`,
      model: `model-${ordinal}`,
    }
  })
}

function descendingAgentRows(count: number): readonly AgentRow[] {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = count - index - 1
    return {
      name: `agent-${String(ordinal).padStart(2, "0")}`,
      status: ordinal % 2 === 0 ? "running" : "busy",
    }
  })
}

const NOW = 10_000_000
const SESSION_A = "session-a", SESSION_B = "session-b"
const sessionAJobs = [{ title: "A only", status: "running", toolCalls: 1, lastTool: "read" }] as const
const sessionBJobs = [{ title: "B only", status: "pending", toolCalls: 2, lastTool: "grep" }] as const
const originalXdgDataHome = process.env.XDG_DATA_HOME
let testRoot = ""
let projectDir = ""

function overwriteSessionFile(sessionId: string, raw: unknown): void {
  const hash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 16)
  const filePath = join(mirrorStorageDir(), "jobs", hash(canonicalProjectDir(projectDir)), `${hash(sessionId)}.json`)
  writeFileSync(filePath, typeof raw === "string" ? raw : JSON.stringify(raw), "utf-8")
}

function jobsViewKey(jobs: JobBoardState): string {
  return viewKey(computeView({ config: { kind: "valid" }, roster: { kind: "empty" }, agents: { kind: "none" }, jobs, loop: { kind: "none" }, teams: { kind: "none" } }))
}

describe("tui sidebar section derivers", () => {
  it("#given a valid config result #when deriving config #then it returns the valid state", () => {
    // given
    const result = { valid: true, messages: ["ignored"] }

    // when
    const state = deriveConfig(result)

    // then
    expect(state).toEqual({ kind: "valid" })
  })

  it("#given an invalid config result #when deriving config #then it copies messages into invalid state", () => {
    // given
    const messages = ["bad enum", "bad model"]

    // when
    const state = deriveConfig({ valid: false, messages })
    messages.push("mutated later")

    // then
    expect(state).toEqual({ kind: "invalid", messages: ["bad enum", "bad model"] })
  })

  it("#given no roster rows #when deriving roster #then it returns empty", () => {
    // given
    const rows: readonly RosterRow[] = []

    // when
    const state = deriveRoster(rows)

    // then
    expect(state).toEqual({ kind: "empty" })
  })

  it("#given unsorted oversized roster rows #when deriving roster #then it sorts by label and caps rows", () => {
    // given
    const rows = descendingRosterRows(MAX_AGENTS + 2)

    // when
    const state = deriveRoster(rows)

    // then
    expect(state.kind).toBe("rows")
    if (state.kind === "rows") {
      expect(state.rows).toHaveLength(MAX_AGENTS)
      expect(state.rows.map((row) => row.label)).toEqual(
        Array.from({ length: MAX_AGENTS }, (_, index) => `Agent ${String(index).padStart(2, "0")}`),
      )
    }
  })

  it("#given no runtime snapshot or no active agents #when deriving agents #then it returns none", () => {
    // given
    const emptySnapshot = snapshot({})

    // when
    const nullState = deriveAgents(null)
    const emptyState = deriveAgents(emptySnapshot)

    // then
    expect(nullState).toEqual({ kind: "none" })
    expect(emptyState).toEqual({ kind: "none" })
  })

  it("#given unsorted oversized active agents #when deriving agents #then it sorts by name and caps rows", () => {
    // given
    const activeAgents = descendingAgentRows(MAX_AGENTS + 2)

    // when
    const state = deriveAgents(snapshot({ activeAgents }))

    // then
    expect(state.kind).toBe("list")
    if (state.kind === "list") {
      expect(state.agents).toHaveLength(MAX_AGENTS)
      expect(state.agents.map((agent) => agent.name)).toEqual(
        Array.from({ length: MAX_AGENTS }, (_, index) => `agent-${String(index).padStart(2, "0")}`),
      )
    }
  })

  it("#given no runtime snapshot or no live loop #when deriving loop #then it returns none", () => {
    // given
    const emptySnapshot = snapshot({})

    // when
    const nullState = deriveLoop(null)
    const emptyState = deriveLoop(emptySnapshot)

    // then
    expect(nullState).toEqual({ kind: "none" })
    expect(emptyState).toEqual({ kind: "none" })
  })

  it("#given a snapshot with idle team members #when deriving teams #then it keeps every member for rendering", () => {
    // given
    const teams: readonly TeamRow[] = [
      {
        name: "sidebar-team",
        leadSessionId: null,
        members: [
          { name: "running", status: "running", work: "Implementing sidebar", sessionId: "ses-running" },
          { name: "idle", status: "idle", work: null, sessionId: null },
        ],
      },
    ]

    // when
    const state = deriveTeams(snapshot({ teams }))

    // then
    expect(state).toEqual({ kind: "list", teams })
  })

  it("#given a live loop with pass fail pending and blocked counts #when deriving loop #then it passes the live state through", () => {
    // given
    const stateSnapshot = snapshot({ loop: liveLoop })

    // when
    const state = deriveLoop(stateSnapshot)

    // then
    expect(state).toBe(liveLoop)
    expect(state).toEqual({
      kind: "live",
      goalsDone: 2,
      goalsTotal: 5,
      pass: 3,
      fail: 1,
      pending: 4,
      blocked: 2,
      activeGoal: "Ship sidebar",
    })
  })
})

describe("exact current-session Jobs derivation", () => {
  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "omo-current-session-jobs-"))
    process.env.XDG_DATA_HOME = join(testRoot, "xdg")
    projectDir = join(testRoot, "project")
    mkdirSync(projectDir, { recursive: true })
  })

  afterEach(() => {
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = originalXdgDataHome
    rmSync(testRoot, { recursive: true, force: true })
  })

  it("#given exact mirrors for sessions A and B #when deriving A, B, no session, then A #then each route sees only its exact board", () => {
    // given
    writeSessionJobsMirror(projectDir, SESSION_A, sessionAJobs, NOW)
    writeSessionJobsMirror(projectDir, SESSION_B, sessionBJobs, NOW)

    // when
    const states = [SESSION_A, SESSION_B, null, SESSION_A].map((sessionId) => deriveCurrentSessionJobs(projectDir, sessionId, NOW))

    // then
    expect(states).toEqual([{ kind: "list", jobs: sessionAJobs }, { kind: "list", jobs: sessionBJobs }, { kind: "none" }, { kind: "list", jobs: sessionAJobs }])
  })

  const invalidSessionCases: readonly (readonly [string, () => void])[] = [
    ["missing", () => undefined],
    ["malformed", () => overwriteSessionFile(SESSION_A, "{")],
    ["stale", () => writeSessionJobsMirror(projectDir, SESSION_A, sessionAJobs, NOW - STALE_MS - 1)],
    ["foreign", () => overwriteSessionFile(SESSION_A, { version: 1, projectDir: canonicalProjectDir(projectDir), parentSessionId: "foreign", updatedAt: NOW, jobs: sessionAJobs })],
  ]
  for (const [condition, prepareA] of invalidSessionCases) {
    it(`#given a ${condition} session A mirror and fresh session B #when deriving both #then A is none and B stays isolated`, () => {
      // given
      writeSessionJobsMirror(projectDir, SESSION_B, sessionBJobs, NOW)
      prepareA()

      // when
      const sessionA = deriveCurrentSessionJobs(projectDir, SESSION_A, NOW)
      const sessionB = deriveCurrentSessionJobs(projectDir, SESSION_B, NOW)

      // then
      expect(sessionA).toEqual({ kind: "none" })
      expect(sessionB).toEqual({ kind: "list", jobs: sessionBJobs })
    })
  }

  it("#given an oversized exact-session board #when deriving it #then status and title ordering apply before the cap", () => {
    // given
    const statusPriority = ["running", "pending", "interrupt", "error", "cancelled", "completed"] as const satisfies readonly JobRow["status"][]
    const jobs = [
      { title: "z-completed-capped", status: "completed", toolCalls: null, lastTool: null },
      ...[...statusPriority].reverse().flatMap((status) => ["b", "a"].map((prefix) => ({ title: `${prefix}-${status}`, status, toolCalls: null, lastTool: null }))),
    ] as const satisfies readonly JobRow[]
    writeSessionJobsMirror(projectDir, SESSION_A, jobs, NOW)

    // when
    const state = deriveCurrentSessionJobs(projectDir, SESSION_A, NOW)

    // then
    expect(state.kind).toBe("list")
    if (state.kind === "list") {
      expect(state.jobs).toHaveLength(MAX_JOBS)
      expect(state.jobs.map((job: JobRow) => `${job.status}:${job.title}`)).toEqual(statusPriority.flatMap((status) => [`${status}:a-${status}`, `${status}:b-${status}`]))
    }
  })

  it("#given session A state and key #when unrelated session B becomes empty #then A state and key do not change", () => {
    // given
    writeSessionJobsMirror(projectDir, SESSION_A, sessionAJobs, NOW)
    const before = deriveCurrentSessionJobs(projectDir, SESSION_A, NOW)
    const beforeKey = jobsViewKey(before)

    // when
    writeSessionJobsMirror(projectDir, SESSION_B, sessionBJobs, NOW)
    writeSessionJobsMirror(projectDir, SESSION_B, [], NOW)
    const after = deriveCurrentSessionJobs(projectDir, SESSION_A, NOW)

    // then
    expect(after).toEqual(before)
    expect(jobsViewKey(after)).toBe(beforeKey)
  })
})
