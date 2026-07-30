/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { MIRROR_SCHEMA_VERSION } from "./features/tui-sidebar/constants"
import { viewKey } from "./features/tui-sidebar/compute-view"
import { mirrorFilePath } from "./features/tui-sidebar/mirror-path"
import { describeView } from "./features/tui-sidebar/render-view"
import { writeSessionJobsMirror } from "./features/tui-sidebar/session-jobs-mirror"
import { TeamSessionCache } from "./features/tui-sidebar/team-session-cache"
import type { TuiRuntimeSnapshot } from "./features/tui-sidebar/snapshot-schema"
import { readView } from "./tui"

const originalXdgDataHome = process.env.XDG_DATA_HOME

function snapshotWithActivity(tempDir: string, withActivity = true): TuiRuntimeSnapshot {
  return {
    version: MIRROR_SCHEMA_VERSION,
    projectDir: tempDir,
    updatedAt: Date.now(),
    activeAgents: [],
    loop: withActivity ? {
      kind: "live",
      goalsDone: 1,
      goalsTotal: 2,
      pass: 3,
      fail: 0,
      pending: 1,
      blocked: 0,
      activeGoal: "keep ULW visible",
    } : null,
    teams: withActivity ? [{
      name: "stable-session-team",
      leadSessionId: "ses-team",
      members: [{ name: "teammate", status: "running", work: "keep Team visible", sessionId: "ses-team" }],
    }] : [],
  }
}

function writeRawMirror(projectDir: string, raw: unknown): void {
  const filePath = mirrorFilePath(projectDir)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, typeof raw === "string" ? raw : JSON.stringify(raw), "utf-8")
}

describe("TUI session Jobs", () => {
  let tempDir = ""

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "omo-tui-session-jobs-"))
    process.env.XDG_DATA_HOME = join(tempDir, "xdg")
  })

  afterEach(() => {
    if (originalXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME
    } else {
      process.env.XDG_DATA_HOME = originalXdgDataHome
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("#given hostile global mirrors and no exact session file #when deriving home and settings-equivalent views #then global Jobs cannot activate the sidebar", async () => {
    // given
    const hostileGlobalMirrors: readonly unknown[] = [
      { ...snapshotWithActivity(tempDir, false), version: 1, jobBoard: [] },
      "{",
      snapshotWithActivity(tempDir, false),
      {
        ...snapshotWithActivity(tempDir, false),
        version: 1,
        jobBoard: [{ title: "stale global job", status: "running", toolCalls: 1, lastTool: "grep" }],
      },
    ]
    let idleKey: string | null = null

    // when
    for (const hostileGlobalMirror of hostileGlobalMirrors) {
      writeRawMirror(tempDir, hostileGlobalMirror)
      const view = await readView(tempDir, null, new TeamSessionCache())
      const key = viewKey(view)

      // then
      expect(view.kind).toBe("idle")
      expect(describeView(view)).toBe("")
      if (idleKey === null) {
        idleKey = key
      } else {
        expect(key).toBe(idleKey)
      }
    }
  })

  it("#given exact session Jobs and hostile global mirrors #when routes switch A to B to home settings and A #then descriptions and keys retain only the current session Jobs", async () => {
    // given
    const sessionA = "session-a"
    const sessionB = "session-b"
    const sessionAJobs = [{ title: "A exact job", status: "running", toolCalls: 1, lastTool: "grep" }] as const
    const sessionBJobs = [{ title: "B exact job", status: "pending", toolCalls: 2, lastTool: "read" }] as const
    writeSessionJobsMirror(tempDir, sessionA, sessionAJobs)
    writeSessionJobsMirror(tempDir, sessionB, sessionBJobs)
    const hostileGlobalMirrors: readonly unknown[] = [
      snapshotWithActivity(tempDir),
      {
        ...snapshotWithActivity(tempDir),
        version: 1,
        jobBoard: [],
      },
      {
        version: MIRROR_SCHEMA_VERSION,
        projectDir: tempDir,
        updatedAt: Date.now(),
        activeAgents: [],
        loop: null,
        teams: [],
      },
      {
        ...snapshotWithActivity(tempDir),
        version: 1,
        jobBoard: [{ title: "stale global job", status: "running", toolCalls: 9, lastTool: "bash" }],
      },
      snapshotWithActivity(tempDir),
      snapshotWithActivity(tempDir),
    ]
    const routeExpectations = [
      { sessionId: sessionA },
      { sessionId: sessionB },
      { sessionId: null },
      { sessionId: null },
      { sessionId: sessionA },
      { sessionId: sessionA },
    ] as const
    const descriptions: string[] = []
    const keys: string[] = []

    // when
    for (const [index, route] of routeExpectations.entries()) {
      writeRawMirror(tempDir, hostileGlobalMirrors[index])
      const view = await readView(tempDir, route.sessionId, new TeamSessionCache())
      descriptions.push(describeView(view))
      keys.push(viewKey(view))
    }

    // then
    expect(descriptions[0]).toContain("Jobs")
    expect(descriptions[0]).toContain("A exact job")
    expect(descriptions[0]).not.toContain("B exact job")
    expect(descriptions[1]).toContain("Jobs")
    expect(descriptions[1]).toContain("B exact job")
    expect(descriptions[1]).not.toContain("A exact job")
    expect(descriptions[2]).not.toContain("Jobs")
    expect(descriptions[3]).not.toContain("Jobs")
    expect(descriptions[4]).toContain("A exact job")
    expect(descriptions[5]).toContain("A exact job")
    for (const description of descriptions) {
      expect(description).not.toContain("stale global job")
    }
    expect(keys[0]).not.toBe(keys[1])
    expect(keys[0]).toBe(keys[4])
    expect(keys[4]).toBe(keys[5])
  })
})
