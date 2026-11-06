/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"

import { OhMyOpenCodeConfigSchema } from "./config/schema/oh-my-opencode-config"
import { createManagers } from "./create-managers"
import * as openclawRuntimeDispatch from "./openclaw/runtime-dispatch"
import * as sessionCleanup from "./features/team-mode/team-runtime/session-cleanup"
import { createModelCacheState } from "./plugin-state"
import { V2BackgroundLifecycle } from "./v2/background-lifecycle"
import { bindV2BackgroundJobs, createPluginInput } from "./v2/create-plugin-input"
import { createFakePluginContext } from "./v2/fake-plugin-context"
import { createSessionTracker } from "./v2/session-tracker"
import type { NativeBackgroundJobs } from "./features/background-agent/native-lifecycle"
import type { SessionAgentResolver } from "./features/tui-sidebar/snapshot-builder"

type CleanupRegistration = {
  shutdown: () => void | Promise<void>
}

const markServerRunningInProcess = mock(() => {})
let backgroundManagerOptions: {
  onSubagentSessionCreated?: (event: { sessionID: string; parentID: string; title: string }) => Promise<void>
  onShutdown?: () => void | Promise<void>
} | null = null
const trackedPaneBySession = new Map<string, string>()
const registeredCleanupManagers: CleanupRegistration[] = []
const tuiMirrorConstructedInputs: unknown[] = []
let tuiMirrorStartCount = 0
let tuiMirrorStopCount = 0

class MockBackgroundManager {
  constructor(config: {
    onSubagentSessionCreated?: (event: { sessionID: string; parentID: string; title: string }) => Promise<void>
    onShutdown?: () => void | Promise<void>
  }) {
    backgroundManagerOptions = config
  }

  async shutdown(): Promise<void> {
    await backgroundManagerOptions?.onShutdown?.()
  }
}

class MockSkillMcpManager {
  constructor(..._args: unknown[]) {}
}

class MockTmuxSessionManager {
  constructor(_ctx: PluginInput, _config: unknown) {}

  async cleanup(): Promise<void> {}

  async onSessionCreated(event: { properties?: { info?: { id?: string } } }): Promise<void> {
    const sessionID = event.properties?.info?.id
    if (sessionID) {
      trackedPaneBySession.set(sessionID, `%pane-${sessionID}`)
    }
  }

  getTrackedPaneId(sessionID: string): string | undefined {
    return trackedPaneBySession.get(sessionID)
  }
}

class MockTuiStateMirror {
  constructor(input: unknown) {
    tuiMirrorConstructedInputs.push(input)
  }

  start(): void {
    tuiMirrorStartCount += 1
  }

  stop(): void {
    tuiMirrorStopCount += 1
  }
}

function createConfigHandler(): ReturnType<typeof import("./plugin-handlers").createConfigHandler> {
  return async () => {}
}

function initTaskToastManager(): ReturnType<typeof import("./features/task-toast-manager").initTaskToastManager> {
  return {} as ReturnType<typeof import("./features/task-toast-manager").initTaskToastManager>
}

function registerManagerForCleanup(manager: CleanupRegistration): void {
  registeredCleanupManagers.push(manager)
}

function createDeps(): NonNullable<Parameters<typeof createManagers>[0]["deps"]> {
  return {
    BackgroundManagerClass: MockBackgroundManager as typeof import("./features/background-agent").BackgroundManager,
    SkillMcpManagerClass: MockSkillMcpManager as typeof import("./features/skill-mcp-manager").SkillMcpManager,
    TmuxSessionManagerClass: MockTmuxSessionManager as typeof import("./features/tmux-subagent").TmuxSessionManager,
    TuiStateMirrorClass: MockTuiStateMirror as typeof import("./features/tui-sidebar/mirror-manager").TuiStateMirror,
    initTaskToastManagerFn: initTaskToastManager,
    registerManagerForCleanupFn: registerManagerForCleanup,
    createConfigHandlerFn: createConfigHandler,
    markServerRunningInProcessFn: markServerRunningInProcess,
  }
}

const unusedNativeJobs: NativeBackgroundJobs = {
  prepare: async () => {
    throw new Error("native jobs are not exercised by this test")
  },
  start: async () => {
    throw new Error("native jobs are not exercised by this test")
  },
  cancel: async () => {
    throw new Error("native jobs are not exercised by this test")
  },
  revokeProvisioning: async () => {
    throw new Error("native jobs are not exercised by this test")
  },
  wait: async () => {
    throw new Error("native jobs are not exercised by this test")
  },
  restore: async () => {
    throw new Error("native jobs are not exercised by this test")
  },
  stop: () => {},
}

function createTmuxConfig(enabled: boolean) {
  return {
    enabled,
    layout: "main-vertical" as const,
    main_pane_size: 60,
    main_pane_min_width: 120,
    agent_pane_min_width: 40,
    isolation: "inline" as const,
  }
}

function createContext(directory: string): PluginInput {
  const shell = Object.assign(
    () => {
      throw new Error("shell should not be called in this test")
    },
    {
      braces: () => [],
      escape: (input: string) => input,
      env() {
        return shell
      },
      cwd() {
        return shell
      },
      nothrow() {
        return shell
      },
      throws() {
        return shell
      },
    },
  )

  return {
    project: {
      id: "project-id",
      worktree: directory,
      time: { created: Date.now() },
    },
    directory,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost:4096"),
    $: shell,
    client: {} as PluginInput["client"],
  }
}

describe("createManagers", () => {
  let dispatchOpenClawEvent: ReturnType<typeof spyOn>
  let cleanupSessionTeamRunsSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    dispatchOpenClawEvent = spyOn(openclawRuntimeDispatch, "dispatchOpenClawEvent")
    cleanupSessionTeamRunsSpy = spyOn(sessionCleanup, "cleanupSessionTeamRuns")
    markServerRunningInProcess.mockClear()
    dispatchOpenClawEvent.mockReset()
    cleanupSessionTeamRunsSpy.mockReset()
    backgroundManagerOptions = null
    trackedPaneBySession.clear()
    registeredCleanupManagers.length = 0
    tuiMirrorConstructedInputs.length = 0
    tuiMirrorStartCount = 0
    tuiMirrorStopCount = 0
  })

  afterEach(async () => {
    for (const manager of registeredCleanupManagers.splice(0)) {
      await manager.shutdown()
    }
    dispatchOpenClawEvent.mockRestore()
    cleanupSessionTeamRunsSpy.mockRestore()
  })

  it("#given tmux integration is disabled #when managers are created #then it does not mark the tmux server as running", () => {
    const args = {
      ctx: createContext("/tmp"),
      pluginConfig: OhMyOpenCodeConfigSchema.parse({}),
      tmuxConfig: createTmuxConfig(false),
      modelCacheState: createModelCacheState(),
      backgroundNotificationHookEnabled: false,
      deps: createDeps(),
    }

    createManagers(args)

    expect(markServerRunningInProcess).not.toHaveBeenCalled()
  })

  it("#given tmux integration is enabled #when managers are created #then it marks the tmux server as running", () => {
    const args = {
      ctx: createContext("/tmp"),
      pluginConfig: OhMyOpenCodeConfigSchema.parse({}),
      tmuxConfig: createTmuxConfig(true),
      modelCacheState: createModelCacheState(),
      backgroundNotificationHookEnabled: false,
      deps: createDeps(),
    }

    createManagers(args)

    expect(markServerRunningInProcess).toHaveBeenCalledTimes(1)
  })

  it("#given tmux is enabled but ctx.serverUrl is undefined #when managers are created #then it does NOT mark the server as running (issue #3894)", () => {
    // Vanilla `opencode` (no `opencode serve` / `opencode web`) leaves
    // ctx.serverUrl undefined. Marking the server as in-process running
    // would short-circuit isServerRunning() in createTeamLayout, letting
    // it spawn tmux panes whose `opencode attach` then fails because no
    // server is actually listening on the fallback port.
    const ctx = createContext("/tmp")
    const ctxWithoutServerUrl = { ...ctx, serverUrl: undefined as unknown as URL }
    const args = {
      ctx: ctxWithoutServerUrl,
      pluginConfig: OhMyOpenCodeConfigSchema.parse({}),
      tmuxConfig: createTmuxConfig(true),
      modelCacheState: createModelCacheState(),
      backgroundNotificationHookEnabled: false,
      deps: createDeps(),
    }

    createManagers(args)

    expect(markServerRunningInProcess).not.toHaveBeenCalled()
  })

  it("#given openclaw is enabled #when the background session-created callback runs #then it dispatches openclaw with the tracked pane id", async () => {
    const args = {
      ctx: createContext("/tmp/project"),
      pluginConfig: OhMyOpenCodeConfigSchema.parse({
        openclaw: {
          enabled: true,
          gateways: {},
          hooks: {},
        },
      }),
      tmuxConfig: createTmuxConfig(true),
      modelCacheState: createModelCacheState(),
      backgroundNotificationHookEnabled: false,
      deps: createDeps(),
    }

    createManagers(args)

    await backgroundManagerOptions?.onSubagentSessionCreated?.({
      sessionID: "ses-bg-1",
      parentID: "ses-parent",
      title: "child task",
    })

    expect(dispatchOpenClawEvent).toHaveBeenCalledTimes(1)
    expect(dispatchOpenClawEvent).toHaveBeenCalledWith({
      config: args.pluginConfig.openclaw,
      rawEvent: "session.created",
      context: {
        sessionId: "ses-bg-1",
        projectPath: "/tmp/project",
        tmuxPaneId: "%pane-ses-bg-1",
      },
    })
  })

  it("#given team mode is enabled #when process cleanup runs #then durable session team runs are preserved", async () => {
    const args = {
      ctx: createContext("/tmp/project"),
      pluginConfig: OhMyOpenCodeConfigSchema.parse({
        team_mode: {
          enabled: true,
          tmux_visualization: true,
        },
      }),
      tmuxConfig: createTmuxConfig(true),
      modelCacheState: createModelCacheState(),
      backgroundNotificationHookEnabled: false,
      deps: createDeps(),
    }

    createManagers(args)

    await registeredCleanupManagers[0]?.shutdown()

    expect(cleanupSessionTeamRunsSpy).not.toHaveBeenCalled()
  })

  it("#given team mode is enabled #when background manager shutdown runs #then durable session team runs are preserved", async () => {
    const args = {
      ctx: createContext("/tmp/project"),
      pluginConfig: OhMyOpenCodeConfigSchema.parse({
        team_mode: {
          enabled: true,
          tmux_visualization: true,
        },
      }),
      tmuxConfig: createTmuxConfig(true),
      modelCacheState: createModelCacheState(),
      backgroundNotificationHookEnabled: false,
      deps: createDeps(),
    }

    const managers = createManagers(args)

    await managers.backgroundManager.shutdown()

    expect(cleanupSessionTeamRunsSpy).not.toHaveBeenCalled()
  })

  it("#given TuiStateMirror is enabled #when managers are created and cleanup runs #then it starts and stops the mirror", async () => {
    const args = {
      ctx: createContext("/tmp/project"),
      pluginConfig: OhMyOpenCodeConfigSchema.parse({}),
      tmuxConfig: createTmuxConfig(false),
      modelCacheState: createModelCacheState(),
      backgroundNotificationHookEnabled: false,
      deps: createDeps(),
    }

    const managers = createManagers(args)

    await registeredCleanupManagers[0]?.shutdown()

    expect(managers.tuiStateMirror).toBeInstanceOf(MockTuiStateMirror)
    expect(tuiMirrorConstructedInputs).toHaveLength(1)
    expect(tuiMirrorConstructedInputs[0]).toMatchObject({
      client: args.ctx.client,
      projectDir: "/tmp/project",
      backgroundManager: managers.backgroundManager,
    })
    expect(tuiMirrorStartCount).toBe(1)
    expect(tuiMirrorStopCount).toBe(1)
  })

  it("#given monitor and sidebar enabled #when managers are created #then the sidebar receives the same session-scoped monitor manager", () => {
    // given
    const args = {
      ctx: createContext("/tmp/project"),
      pluginConfig: OhMyOpenCodeConfigSchema.parse({ monitor: { enabled: true } }),
      tmuxConfig: createTmuxConfig(false),
      modelCacheState: createModelCacheState(),
      backgroundNotificationHookEnabled: false,
      deps: createDeps(),
    }

    // when
    const managers = createManagers(args)

    // then
    expect(managers.monitorManager).toBeDefined()
    expect(tuiMirrorConstructedInputs[0]).toMatchObject({ monitorManager: managers.monitorManager })
    managers.tuiStateMirror?.stop()
  })

  it("#given TuiStateMirror is enabled #when normal shutdown runs #then it stops the mirror", async () => {
    const args = {
      ctx: createContext("/tmp/project"),
      pluginConfig: OhMyOpenCodeConfigSchema.parse({}),
      tmuxConfig: createTmuxConfig(false),
      modelCacheState: createModelCacheState(),
      backgroundNotificationHookEnabled: false,
      deps: createDeps(),
    }

    const managers = createManagers(args)

    await managers.backgroundManager.shutdown()

    expect(managers.tuiStateMirror).toBeInstanceOf(MockTuiStateMirror)
    expect(tuiMirrorStartCount).toBe(1)
    expect(tuiMirrorStopCount).toBe(1)
  })

  it("#given TuiStateMirror is disabled #when managers are created #then it is not constructed or started", () => {
    const args = {
      ctx: createContext("/tmp/project"),
      pluginConfig: OhMyOpenCodeConfigSchema.parse({
        tui: { sidebar: { enabled: false } },
      }),
      tmuxConfig: createTmuxConfig(false),
      modelCacheState: createModelCacheState(),
      backgroundNotificationHookEnabled: false,
      deps: createDeps(),
    }

    const managers = createManagers(args)

    expect(managers.tuiStateMirror).toBeUndefined()
    expect(tuiMirrorConstructedInputs).toHaveLength(0)
    expect(tuiMirrorStartCount).toBe(0)
  })

  it("#given a V2 plugin input #when managers are created #then the sidebar mirror resolves agent labels from native session metadata without reading session history", async () => {
    // given
    const fake = createFakePluginContext({ sessionAgent: "sisyphus" })
    if (!fake.context.storage) throw new Error("fake context storage is required")
    let contextCalls = 0
    const context = {
      ...fake.context,
      session: {
        ...fake.context.session,
        get: async ({ sessionID }: { readonly sessionID: string }) => {
          if (sessionID === "ses_missing") throw new Error("SessionNotFoundError")
          return fake.context.session.get({ sessionID })
        },
        context: async (input: { readonly sessionID: string }) => {
          contextCalls += 1
          return fake.context.session.context(input)
        },
      },
    }
    const lifecycle = new V2BackgroundLifecycle(context, context.storage)
    const input = createPluginInput(context, { tracker: createSessionTracker(), warn: () => {} }, lifecycle)
    bindV2BackgroundJobs(input, unusedNativeJobs)
    const args = {
      ctx: input,
      pluginConfig: OhMyOpenCodeConfigSchema.parse({}),
      tmuxConfig: createTmuxConfig(false),
      modelCacheState: createModelCacheState(),
      backgroundNotificationHookEnabled: false,
      deps: createDeps(),
    }

    // when
    createManagers(args)
    const mirrorInput = tuiMirrorConstructedInputs.at(-1) as
      { readonly sessionAgentResolver?: SessionAgentResolver } | undefined
    const resolver = mirrorInput?.sessionAgentResolver

    // then
    expect(resolver).toBeDefined()
    expect(await resolver?.("ses_1", input.client)).toBe("sisyphus")
    expect(await resolver?.("ses_missing", input.client)).toBeNull()
    expect(contextCalls).toBe(0)
  })
})
