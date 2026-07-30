/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { HEARTBEAT_MS, STALE_MS, WRITE_DEBOUNCE_MS } from "./constants"
import { readMirror } from "./mirror-io"
import { mirrorStorageDir } from "./mirror-path"
import { TuiStateMirror } from "./mirror-manager"
import { readSessionJobsMirror, writeSessionJobsMirror } from "./session-jobs-mirror"
import type { SessionAgentResolver } from "./snapshot-builder"
import type { BackgroundTaskSnapshot } from "../background-agent/types"

type StatusRow = { readonly type: string }
type StatusMap = Record<string, StatusRow>

type FakeClient = { readonly session: { readonly status: () => Promise<{ readonly data: StatusMap }>; readonly messages: (input: { readonly path: { readonly id: string } }) => Promise<unknown> } }
type FakeBackgroundManager = { readonly getTasksSnapshot: () => readonly BackgroundTaskSnapshot[] }

const originalXdgDataHome = process.env.XDG_DATA_HOME
const tempDirs: string[] = []
const NOW = 10_000_000

const sessionATask = { title: "", status: "running", toolCalls: null, lastTool: null, agent: "atlas", parentSessionId: "parent-session-a" } as const satisfies BackgroundTaskSnapshot
const sessionBTask = { title: "Review results", status: "completed", toolCalls: 3, lastTool: "read", agent: "explore", parentSessionId: "parent-session-b" } as const satisfies BackgroundTaskSnapshot

function makeTempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `omo-tui-mirror-manager-${label}-`))
  tempDirs.push(dir)
  return dir
}

function restoreXdgDataHome(): void {
  if (originalXdgDataHome === undefined) {
    delete process.env.XDG_DATA_HOME
    return
  }
  process.env.XDG_DATA_HOME = originalXdgDataHome
}

function createClient(statuses: StatusMap): FakeClient {
  return { session: { status: async () => ({ data: statuses }), messages: async () => ({ data: [] }) } }
}

function createBackgroundManager(tasks: readonly BackgroundTaskSnapshot[]): FakeBackgroundManager {
  return { getTasksSnapshot: () => tasks }
}

function createMirror(input?: {
  readonly client?: FakeClient
  readonly projectDir?: string
  readonly backgroundManager?: FakeBackgroundManager
  readonly sessionAgentResolver?: SessionAgentResolver
  readonly reportFlushError?: (error: Error) => void
}): TuiStateMirror {
  const projectDir = input?.projectDir ?? makeTempDir("project")
  return new TuiStateMirror({
    client: input?.client ?? createClient({}),
    projectDir,
    backgroundManager: input?.backgroundManager ?? createBackgroundManager([]),
    sessionAgentResolver: input?.sessionAgentResolver ?? resolveTestSessionAgent,
    reportFlushError: input?.reportFlushError,
  })
}

const resolveTestSessionAgent: SessionAgentResolver = async (sessionID) => {
  switch (sessionID) {
    case "ses-main":
      return "sisyphus"
    case "ses-sub":
      return "atlas"
    default:
      return null
  }
}

describe("TuiStateMirror", () => {
  beforeEach(() => {
    process.env.XDG_DATA_HOME = makeTempDir("xdg")
  })

  afterEach(() => {
    jest.useRealTimers()
    restoreXdgDataHome()
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("#given a mirror manager #when flushing #then it writes a readable mirror", async () => {
    // given
    const projectDir = makeTempDir("flush-project")
    const mirror = createMirror({
      projectDir,
      client: createClient({ "ses-main": { type: "running" } }),
    })

    // when
    await mirror.flush()

    // then
    expect(readMirror(projectDir)?.activeAgents).toEqual([{ name: "sisyphus", status: "running" }])
  })

  it("#given tasks from two parent sessions #when flushing #then each exact session receives only its own display rows", async () => {
    // given
    const projectDir = makeTempDir("two-session-project")
    const mirror = createMirror({
      projectDir,
      backgroundManager: createBackgroundManager([sessionATask, sessionBTask]),
    })

    // when
    await mirror.flush()

    // then
    expect(readSessionJobsMirror(projectDir, "parent-session-a")).toEqual([
      { title: "atlas background task", status: "running", toolCalls: null, lastTool: null },
    ])
    expect(readSessionJobsMirror(projectDir, "parent-session-b")).toEqual([
      { title: "Review results", status: "completed", toolCalls: 3, lastTool: "read" },
    ])
  })

  it("#given a quiet running task #when heartbeats continue beyond staleness #then its session Jobs mirror stays fresh", async () => {
    jest.useFakeTimers()
    jest.setSystemTime(NOW)
    // given
    const projectDir = makeTempDir("heartbeat-project")
    let statusReads = 0
    const mirror = createMirror({
      projectDir,
      client: {
        session: {
          status: async () => {
            statusReads += 1
            return { data: {} }
          },
          messages: async () => ({ data: [] }),
        },
      },
      backgroundManager: createBackgroundManager([sessionATask]),
    })
    const initialWrite = mirror.flush()
    jest.advanceTimersByTime(WRITE_DEBOUNCE_MS)
    await initialWrite
    mirror.start()

    // when
    for (let heartbeat = 1; heartbeat <= 4; heartbeat += 1) {
      jest.advanceTimersByTime(HEARTBEAT_MS)
      jest.advanceTimersByTime(WRITE_DEBOUNCE_MS)
      expect(statusReads).toBe(heartbeat + 1)
      await mirror.flush()
    }

    // then
    expect(Date.now() - NOW).toBeGreaterThan(STALE_MS)
    expect(readSessionJobsMirror(projectDir, "parent-session-a", Date.now())).toEqual([
      { title: "atlas background task", status: "running", toolCalls: null, lastTool: null },
    ])
    mirror.stop()
  })

  it("#given a started mirror #when started #then heartbeat handle is unref'd", () => {
    jest.useFakeTimers()
    const mirror = createMirror()
    const unref = jest.fn()
    const originalSetInterval = globalThis.setInterval
    globalThis.setInterval = jest.fn(() => ({ unref })) as unknown as typeof setInterval

    try {
      mirror.start()
      expect(unref).toHaveBeenCalledTimes(1)
    } finally {
      mirror.stop()
      globalThis.setInterval = originalSetInterval
    }
  })

  it("#given a started mirror #when stopped #then timers are cleared and no later write occurs", async () => {
    jest.useFakeTimers()
    // given
    const projectDir = makeTempDir("stop-project")
    const mirror = createMirror({
      projectDir,
      client: createClient({ "ses-main": { type: "busy" } }),
    })
    mirror.start()

    // when
    mirror.stop()
    jest.advanceTimersByTime(HEARTBEAT_MS)
    await Promise.resolve()
    jest.advanceTimersByTime(WRITE_DEBOUNCE_MS)
    await Promise.resolve()

    // then
    expect(readMirror(projectDir)).toBeNull()
    mirror.stop()
  })

  it("#given an existing session Jobs mirror #when its manager stops #then the file becomes stale without deletion", async () => {
    jest.useFakeTimers()
    jest.setSystemTime(NOW)
    // given
    const projectDir = makeTempDir("stop-project")
    const mirror = createMirror({
      projectDir,
      backgroundManager: createBackgroundManager([sessionATask]),
    })
    const initialWrite = mirror.flush()
    jest.advanceTimersByTime(WRITE_DEBOUNCE_MS)
    await initialWrite
    mirror.start()

    // when
    mirror.stop()
    jest.advanceTimersByTime(STALE_MS + 1)

    // then
    expect(readSessionJobsMirror(projectDir, "parent-session-a", Date.now())).toBeNull()
    expect(readSessionJobsMirror(projectDir, "parent-session-a", NOW)).toHaveLength(1)
  })

  it("#given another session file and no local tasks #when flushing #then it writes nothing and does not refresh or delete that file", async () => {
    jest.useFakeTimers()
    jest.setSystemTime(NOW)
    // given
    const projectDir = makeTempDir("zero-task-project")
    writeSessionJobsMirror(projectDir, "another-session", [
      { title: "Owned elsewhere", status: "running", toolCalls: 1, lastTool: "grep" },
    ], NOW)
    jest.setSystemTime(NOW + STALE_MS + 1)
    const mirror = createMirror({ projectDir, backgroundManager: createBackgroundManager([]) })

    // when
    const flush = mirror.flush()
    jest.advanceTimersByTime(WRITE_DEBOUNCE_MS)
    await flush

    // then
    expect(readSessionJobsMirror(projectDir, "another-session", Date.now())).toBeNull()
    expect(readSessionJobsMirror(projectDir, "another-session", NOW)).toEqual([
      { title: "Owned elsewhere", status: "running", toolCalls: 1, lastTool: "grep" },
    ])
  })

  it("#given client status throws #when flushing #then status throws no-op with no rejection and no mirror write", async () => {
    // given
    const projectDir = makeTempDir("throw-project")
    const statusError = new Error("status unavailable")
    const reportedErrors: Error[] = []
    const client: FakeClient = {
      session: {
        status: async () => {
          throw statusError
        },
        messages: async () => ({ data: [] }),
      },
    }
    const mirror = createMirror({
      projectDir,
      client,
      reportFlushError: (error) => {
        reportedErrors.push(error)
      },
    })

    // when
    await expect(mirror.flush()).resolves.toBeUndefined()

    // then
    expect(readMirror(projectDir)).toBeNull()
    expect(reportedErrors).toEqual([statusError])
  })

  it("#given a session Jobs write fails after the global write #when flushing #then the error is reported without rejection", async () => {
    // given
    const projectDir = makeTempDir("jobs-write-failure")
    const redirectedJobsDir = makeTempDir("redirected-jobs")
    mkdirSync(mirrorStorageDir(), { recursive: true })
    symlinkSync(redirectedJobsDir, join(mirrorStorageDir(), "jobs"), "dir")
    const reportedErrors: Error[] = []
    const mirror = createMirror({
      projectDir,
      client: createClient({ "ses-main": { type: "running" } }),
      backgroundManager: createBackgroundManager([sessionATask]),
      reportFlushError: (error) => {
        reportedErrors.push(error)
      },
    })

    // when
    await expect(mirror.flush()).resolves.toBeUndefined()

    // then
    expect(readMirror(projectDir)?.activeAgents).toHaveLength(1)
    expect(reportedErrors).toHaveLength(1)
    expect(readSessionJobsMirror(projectDir, "parent-session-a")).toBeNull()
  })

  it("#given concurrent flush calls #when the first build is in flight #then it does not double-build", async () => {
    // given: real timers; the 250ms debounce elapses on its own, and the test
    // subscribes to the actual build start instead of assuming microtask counts
    // (the fake-timer + single-tick version of this test deadlocked on CI).
    const projectDir = makeTempDir("concurrent-project")
    let buildCount = 0
    let snapshotCount = 0
    let releaseBuilds: () => void = () => undefined
    let reportBuildStarted: () => void = () => undefined
    const buildGate = new Promise<void>((resolvePromise) => {
      releaseBuilds = resolvePromise
    })
    const buildStarted = new Promise<void>((resolvePromise) => {
      reportBuildStarted = resolvePromise
    })
    const mirror = createMirror({
      projectDir,
      backgroundManager: {
        getTasksSnapshot: () => {
          snapshotCount += 1
          return [sessionATask]
        },
      },
      client: {
        session: {
          status: async () => {
            buildCount += 1
            reportBuildStarted()
            await buildGate
            return { data: { "ses-main": { type: "busy" } } }
          },
          messages: async () => ({ data: [] }),
        },
      },
    })

    // when
    const firstFlush = mirror.flush()
    const secondFlush = mirror.flush()
    await buildStarted
    releaseBuilds()
    await Promise.all([firstFlush, secondFlush])

    // then
    expect(buildCount).toBe(1)
    expect(snapshotCount).toBe(1)
    expect(readSessionJobsMirror(projectDir, "parent-session-a")).toHaveLength(1)
  })
})
