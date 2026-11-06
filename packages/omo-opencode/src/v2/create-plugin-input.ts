import type { PluginInput } from "@opencode-ai/plugin"
import type { V2PluginContext } from "./context-types"
import { createClientFacade } from "./client-facade"
import type { ClientFacadeDeps } from "./client-facade/create-client-facade"
import { V2UnsupportedOperationError } from "./unsupported-operation-error"
import type { V2BackgroundLifecycle } from "./background-lifecycle"
import type { NativeBackgroundJobs } from "../features/background-agent/native-lifecycle"
import { attachNativeSkillState } from "./native-skill-state"
import type { DashboardOwners } from "./dashboard-projection"
import { bindNativeTeamWorktrees, createNativeTeamWorktrees } from "./native-team-worktrees"

type V1Shell = PluginInput["$"]
const v2Inputs = new WeakSet<PluginInput>()
const backgroundLifecycles = new WeakMap<PluginInput, V2BackgroundLifecycle>()
const backgroundJobs = new WeakMap<PluginInput, NativeBackgroundJobs>()
const sessionEnvironments = new WeakMap<PluginInput, (sessionID: string) => Promise<Readonly<Record<string, string>> | undefined>>()
const sessionAgentLookups = new WeakMap<PluginInput, (sessionID: string) => Promise<string | null>>()
const nativeContexts = new WeakMap<PluginInput, V2PluginContext>()
const dashboardOwners = new WeakMap<V2PluginContext, DashboardOwners>()

export function bindV2DashboardOwners(input: PluginInput, owners: DashboardOwners): void {
  const context = nativeContexts.get(input)
  if (context) dashboardOwners.set(context, owners)
}

export function getV2DashboardOwners(context: V2PluginContext): DashboardOwners | undefined {
  return dashboardOwners.get(context)
}

export function getV2SessionEnvironment(input: PluginInput) {
  return sessionEnvironments.get(input)
}

/** Current selected agent from native session metadata; never reads the session transcript. */
export function getV2SessionAgentLookup(input: PluginInput) {
  return sessionAgentLookups.get(input)
}

export function bindV2BackgroundJobs(input: PluginInput, jobs: NativeBackgroundJobs): void {
  backgroundJobs.set(input, jobs)
}

export function getV2BackgroundJobs(input: PluginInput): NativeBackgroundJobs | undefined {
  return backgroundJobs.get(input)
}

export function getV2BackgroundLifecycle(input: PluginInput): V2BackgroundLifecycle | undefined {
  return backgroundLifecycles.get(input)
}

export function isV2PluginInput(input: PluginInput): boolean {
  return v2Inputs.has(input)
}

function resolveShell(): V1Shell {
  if (typeof Bun !== "undefined") return Bun.$ as unknown as V1Shell
  return (() => {
    throw new V2UnsupportedOperationError("PluginInput.$")
  }) as unknown as V1Shell
}

/**
 * Builds the V1 `PluginInput` the existing plugin body expects from a V2 plugin context.
 *
 * `serverUrl` is intentionally not set: OpenCode 2.x exposes server URLs through `GET /api/info`,
 * not to plugins, and a `--standalone` server has no HTTP port at all. The V1 code already treats
 * an undefined `serverUrl` as "no live server" (see create-managers.ts).
 */
export function createPluginInput(context: V2PluginContext, deps: ClientFacadeDeps, backgroundLifecycle?: V2BackgroundLifecycle): PluginInput {
  const { directory, project } = context.location
  const input: PluginInput = {
    client: createClientFacade(context, deps),
    project: {
      id: project.id,
      worktree: project.canonical,
      time: { created: 0 },
    },
    directory,
    worktree: project.canonical,
    experimental_workspace: { register: () => {} },
    serverUrl: undefined as unknown as URL,
    $: resolveShell(),
  }
  v2Inputs.add(input)
  nativeContexts.set(input, context)
  if (context.worktree) bindNativeTeamWorktrees(input.client, createNativeTeamWorktrees(context))
  sessionEnvironments.set(input, (sessionID) => context.experimental.session.environment({ sessionID }))
  // Lowercased like the V1 history resolver (hooks/atlas/session-last-agent.ts); a failed metadata
  // read yields null so the sidebar keeps its session-id fallback instead of loading history.
  sessionAgentLookups.set(input, async (sessionID) => {
    try {
      const info = await context.session.get({ sessionID })
      return info.agent === undefined ? null : info.agent.toLowerCase()
    } catch (error) {
      if (error instanceof Error) return null
      throw error
    }
  })
  attachNativeSkillState(input, context)
  if (backgroundLifecycle) backgroundLifecycles.set(input, backgroundLifecycle)
  return input
}
