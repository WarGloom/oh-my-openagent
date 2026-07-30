import type { DefaultModeConfig } from "../config/schema/default-mode"
import { reconcileSisyphusRuntimePrompt } from "../agents/sisyphus-runtime-prompt-reconciler"
import { getSerenaNavigationPrompt } from "../shared/serena-navigation-prompt"
import { resolveSessionTools } from "../shared/resolve-session-tools"
import type { PluginContext } from "./types"

const ULTRAWORK_MODE_TAG = "<ultrawork-mode>"

/**
 * Collapse the opencode hook model record into the canonical
 * `"<providerID>/<id>"` string used throughout OMO (model ids arrive bare for
 * builtin providers). Ids that already carry a provider prefix pass through
 * unchanged so both hook payload shapes stay comparable.
 */
function toCanonicalModel(
  model: { id: string; providerID: string } | undefined,
): string | undefined {
  if (!model?.id) return undefined
  if (model.id.includes("/") || !model.providerID) return model.id
  return `${model.providerID}/${model.id}`
}

type SystemTransformInput = {
  sessionID?: string
  model: { id: string; providerID: string; [key: string]: unknown }
}

type SystemTransformOutput = { system: string[] }

type SystemTransformHandler = (
  input: SystemTransformInput,
  output: SystemTransformOutput,
) => Promise<void>

type UltraworkMessageFactory = (agentName?: string, modelID?: string) => string

type SystemTransformOptions = {
  ctx: PluginContext
  defaultMode?: DefaultModeConfig
  getUltraworkMessage?: UltraworkMessageFactory
}

function hasModeOptions(
  value: SystemTransformOptions | DefaultModeConfig | undefined,
): value is SystemTransformOptions {
  return typeof value === "object" && value !== null && "ctx" in value
}

function hasSerenaToolAccess(tools: Record<string, boolean> | undefined): boolean {
  if (!tools) {
    return false
  }

  return Object.entries(tools).some(
    ([toolName, enabled]) => enabled && toolName.toLowerCase().startsWith("serena_"),
  )
}

export function createSystemTransformHandler(args: SystemTransformOptions): SystemTransformHandler
export function createSystemTransformHandler(
  defaultMode?: DefaultModeConfig,
  getUltraworkMessage?: UltraworkMessageFactory,
): SystemTransformHandler
export function createSystemTransformHandler(
  argsOrDefaultMode?: SystemTransformOptions | DefaultModeConfig,
  maybeGetUltraworkMessage?: UltraworkMessageFactory,
): SystemTransformHandler {
  const ctx = hasModeOptions(argsOrDefaultMode) ? argsOrDefaultMode.ctx : undefined
  const defaultMode = hasModeOptions(argsOrDefaultMode) ? argsOrDefaultMode.defaultMode : argsOrDefaultMode
  const getUltraworkMessage = hasModeOptions(argsOrDefaultMode)
    ? argsOrDefaultMode.getUltraworkMessage
    : maybeGetUltraworkMessage

  return async (input, output): Promise<void> => {
    // The Sisyphus prompt body is model-specific and baked at registration
    // from the *configured* model in .omo/omo.jsonc. This per-request hook
    // is the only seam that knows the model actually selected at runtime, so
    // rebuild the whole body for the runtime model here (issue #5297/#6966).
    reconcileSisyphusRuntimePrompt(output.system, toCanonicalModel(input.model))

    if (defaultMode?.ultrawork && getUltraworkMessage) {
      if (!output.system.some((part) => part.includes(ULTRAWORK_MODE_TAG))) {
        const modelID = input.model?.id
        const ultraworkMessage = getUltraworkMessage("sisyphus", modelID)
        if (ultraworkMessage) {
          output.system.push(ultraworkMessage)
        }
      }
    }

    if (!ctx) {
      return
    }

    const sessionTools = input.sessionID
      ? await resolveSessionTools(ctx.client, input.sessionID)
      : undefined
    if (!hasSerenaToolAccess(sessionTools)) {
      return
    }

    if (output.system.some((entry) => entry.includes("<serena_navigation>"))) {
      return
    }

    output.system.push(getSerenaNavigationPrompt())
  }
}
