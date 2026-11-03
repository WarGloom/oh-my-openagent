import type { PluginInput } from "@opencode-ai/plugin"
import type { V2PluginContext } from "./context-types"
import { createClientFacade } from "./client-facade"
import type { ClientFacadeDeps } from "./client-facade/create-client-facade"
import { V2UnsupportedOperationError } from "./unsupported-operation-error"
import type { V2BackgroundLifecycle } from "./background-lifecycle"

type V1Shell = PluginInput["$"]
const v2Inputs = new WeakSet<PluginInput>()
const backgroundLifecycles = new WeakMap<PluginInput, V2BackgroundLifecycle>()

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
export function createPluginInput(
  context: V2PluginContext,
  deps: ClientFacadeDeps,
  backgroundLifecycle?: V2BackgroundLifecycle,
): PluginInput {
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
  if (backgroundLifecycle) backgroundLifecycles.set(input, backgroundLifecycle)
  return input
}
