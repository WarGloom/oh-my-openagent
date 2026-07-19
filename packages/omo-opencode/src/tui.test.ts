/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { TuiSlotPlugin } from "@opencode-ai/plugin/tui"

import { MIRROR_SCHEMA_VERSION } from "./features/tui-sidebar/constants"
import { viewKey } from "./features/tui-sidebar/compute-view"
import { writeMirror } from "./features/tui-sidebar/mirror-io"
import { describeView } from "./features/tui-sidebar/render-view"
import { TeamSessionCache } from "./features/tui-sidebar/team-session-cache"
import type { TuiRuntimeSnapshot } from "./features/tui-sidebar/snapshot-schema"
import tuiModule, { currentTeamSessionId, handleTuiPollError, materializeReactive, navigateToTeamSession, readView } from "./tui"

type SolidNode = {
  readonly tag: string
  readonly props: Record<string, unknown>
  readonly children: unknown[]
}

type SidebarApiForTest = {
  readonly state: {
    readonly path: {
      readonly directory: string
    }
  }
  readonly theme: {
    readonly current: Record<string, unknown>
  }
  readonly route: {
    readonly current: {
      readonly name: string
      readonly params?: Record<string, unknown>
    }
  }
  readonly slots: {
    readonly register: (registration: TuiSlotPlugin) => string
  }
  readonly renderer: {
    readonly requestRender: () => void
  }
  readonly lifecycle: {
    readonly signal: AbortSignal
    readonly onDispose: (dispose: () => void) => () => void
  }
}

function snapshotWithJobs(tempDir: string, jobBoard: TuiRuntimeSnapshot["jobBoard"], withActivity = true): TuiRuntimeSnapshot {
  return {
    version: MIRROR_SCHEMA_VERSION,
    projectDir: tempDir,
    updatedAt: Date.now(),
    activeAgents: [],
    jobBoard,
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

describe("TUI sidebar polling", () => {
  let tempDir = ""

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "omo-tui-test-"))
  })

  afterEach(() => {
    mock.restore()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("#given the TUI plugin starts #when it registers the sidebar slot #then an initial render is requested immediately", async () => {
    // given
    const calls: string[] = []
    const disposers: (() => void)[] = []
    let registration: TuiSlotPlugin | undefined

    mock.module("@opentui/solid", () => ({
      createElement: (tag: string): SolidNode => ({ tag, props: {}, children: [] }),
      insert: (parent: SolidNode, child: unknown): void => {
        parent.children.push(child)
      },
      setProp: (node: SolidNode, name: string, value: unknown): void => {
        node.props[name] = value
      },
    }))

    const api = {
      state: { path: { directory: tempDir } },
      theme: { current: {} },
      route: { current: { name: "home" } },
      slots: {
        register: (nextRegistration: TuiSlotPlugin): string => {
          calls.push("register")
          registration = nextRegistration
          return "omo-sidebar-slot"
        },
      },
      renderer: {
        requestRender: (): void => {
          calls.push("render")
        },
      },
      lifecycle: {
        signal: new AbortController().signal,
        onDispose: (dispose: () => void): (() => void) => {
          disposers.push(dispose)
          return () => undefined
        },
      },
    } satisfies SidebarApiForTest

    // when
    await Reflect.apply(tuiModule.tui, undefined, [api, undefined, {}])

    // then
    expect(calls).toEqual(["register", "render"])
    expect(registration).toBeDefined()
    if (!registration) {
      throw new Error("sidebar slot was not registered")
    }
    expect(registration.order).toBe(900)
    expect(Object.keys(registration.slots)).toEqual(["sidebar_content"])
    expect(registration.slots.sidebar_content).toBeFunction()
    for (const dispose of disposers) dispose()
  })

  it("#given an unexpected Error during polling #when the poll error handler runs #then the error is logged", () => {
    // given
    const pollError = new TypeError("view derivation failed")
    const reportedErrors: Error[] = []

    // when
    handleTuiPollError(pollError, (error) => {
      reportedErrors.push(error)
    })

    // then
    expect(reportedErrors).toEqual([pollError])
  })

  it("#given a non-Error throw during polling #when the poll error handler runs #then the value is rethrown", () => {
    // given
    const thrownValue = "bad poll state"

    expect(() => handleTuiPollError(thrownValue)).toThrow(thrownValue)
  })

  it("#given a Team member session id #when navigating #then it opens the OpenCode session route", () => {
    // given
    const navigations: Array<{ readonly name: string; readonly params: Record<string, unknown> | undefined }> = []

    // when
    navigateToTeamSession(
      {
        navigate: (name, params): void => {
          navigations.push({ name, params })
        },
      },
      "ses-member",
    )

    // then
    expect(navigations).toEqual([{ name: "session", params: { sessionID: "ses-member" } }])
  })

  it("#given home and session routes #when selecting Team cache scope #then only session routes provide a cache key", () => {
    // given
    const routes = [
      { current: { name: "home" as const } },
      { current: { name: "session" as const, params: { sessionID: "ses-member" } } },
      { current: { name: "settings", params: {} } },
    ]

    // when
    const sessionIds = routes.map((route) => currentTeamSessionId(route))

    // then
    expect(sessionIds).toEqual([null, "ses-member", null])
  })

  it("#given stable ULW and Team mirror state #when deriving the sidebar view #then their rendered output is characterized", async () => {
    // given
    writeMirror(tempDir, snapshotWithJobs(tempDir, []))

    // when
    const view = await readView(tempDir, "ses-team", new TeamSessionCache())
    const description = describeView(view)

    // then
    expect(view.kind).toBe("active")
    expect(description).toContain("ULW")
    expect(description).toContain("Team (1)")
  })

  it("#given alternating global Job Board mirrors #when deriving poll-equivalent views #then Jobs do not alter the rendered view or key", async () => {
    // given
    const jobBoards = [
      [],
      [{ title: "hidden-first-task", status: "running", toolCalls: 1, lastTool: "grep" }],
      [],
      [{ title: "hidden-second-task", status: "pending", toolCalls: 0, lastTool: null }],
    ] satisfies readonly TuiRuntimeSnapshot["jobBoard"][]
    const teamCache = new TeamSessionCache()
    const derivations: Array<{ readonly description: string; readonly key: string; readonly view: Awaited<ReturnType<typeof readView>> }> = []

    // when
    for (const jobBoard of jobBoards) {
      writeMirror(tempDir, snapshotWithJobs(tempDir, jobBoard))
      const view = await readView(tempDir, "ses-team", teamCache)
      derivations.push({ view, key: viewKey(view), description: describeView(view) })
    }

    // then
    const baseline = derivations[0]
    if (baseline === undefined) {
      throw new Error("expected a baseline derivation")
    }
    for (const derivation of derivations) {
      expect(derivation.view).toEqual(baseline.view)
      expect(derivation.key).toBe(baseline.key)
      expect(derivation.description).toBe(baseline.description)
      expect(derivation.description).not.toContain("Jobs")
      expect(derivation.description).not.toContain("hidden-first-task")
      expect(derivation.description).not.toContain("hidden-second-task")
    }
  })

  it("#given only alternating Job Board mirrors #when deriving views #then Jobs cannot activate the sidebar", async () => {
    // given
    const jobBoards = [
      [{ title: "hidden-only-job", status: "running", toolCalls: 1, lastTool: "grep" }],
      [],
      [{ title: "hidden-replaced-job", status: "pending", toolCalls: 0, lastTool: null }],
    ] satisfies readonly TuiRuntimeSnapshot["jobBoard"][]
    let idleKey: string | null = null

    // when
    for (const jobBoard of jobBoards) {
      writeMirror(tempDir, snapshotWithJobs(tempDir, jobBoard, false))
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
})

describe("reactive sidebar materialization", () => {
  it("#given a changing node accessor #when the sidebar root is created #then node construction remains reactive", () => {
    // given
    let readCount = 0
    const solid = {
      createElement: (tag: string): SolidNode => ({ tag, props: {}, children: [] }),
      insert: (parent: SolidNode, child: unknown): void => {
        parent.children.push(child)
      },
      setProp: (node: SolidNode, name: string, value: unknown): void => {
        node.props[name] = value
      },
    }

    // when
    const root = materializeReactive(() => {
      readCount += 1
      return []
    }, solid)

    // then
    expect(readCount).toBe(0)
    expect(root.children[0]).toBeFunction()
    Reflect.apply(root.children[0] as () => SolidNode, undefined, [])
    expect(readCount).toBe(1)
  })
})
