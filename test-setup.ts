import { afterEach, beforeEach, mock } from "bun:test"
import { rmSync } from "node:fs"
import { _resetForTesting as resetClaudeSessionState } from "./src/features/claude-code-session-state/state"
import { _resetTaskToastManagerForTesting as resetTaskToastManager } from "./src/features/task-toast-manager/manager"
import { _resetForTesting as resetModelFallbackState } from "./src/hooks/model-fallback/hook"
import { _resetMemCacheForTesting as resetConnectedProvidersCache } from "./src/shared/connected-providers-cache"
import { SessionCategoryRegistry } from "./src/shared/session-category-registry"
import { clearSessionTools } from "./src/shared/session-tools-store"
import { clearAllSessionPromptParams } from "./src/shared/session-prompt-params-state"
import { clearBackgroundOutputConsumptionState } from "./src/shared/background-output-consumption"
import { clearVisionCapableModelsCache } from "./src/shared/vision-capable-models-cache"
import { _resetForTesting as resetLoggerForTesting } from "./src/shared/logger"
import { clearPluginComponentsCache } from "./src/features/claude-code-plugin-loader/loader"
import { getOmoOpenCodeCacheDir } from "./src/shared/data-path"
import { installModuleMockLifecycle } from "./src/testing/module-mock-lifecycle"

const { restoreModuleMocks } = installModuleMockLifecycle(mock)
let environmentSnapshot: NodeJS.ProcessEnv = { ...process.env }
let workingDirectorySnapshot = process.cwd()

function cleanupOmoCacheDir(cacheDir: string): void {
  rmSync(cacheDir, { recursive: true, force: true })
}

beforeEach(() => {
  environmentSnapshot = { ...process.env }
  workingDirectorySnapshot = process.cwd()
  process.env.OMO_DISABLE_POSTHOG = "true"
  cleanupOmoCacheDir(getOmoOpenCodeCacheDir())
  resetClaudeSessionState()
  resetTaskToastManager()
  resetModelFallbackState()
  resetConnectedProvidersCache()
  SessionCategoryRegistry.clear()
  clearSessionTools()
  clearAllSessionPromptParams()
  clearBackgroundOutputConsumptionState()
  clearVisionCapableModelsCache()
  resetLoggerForTesting()
  clearPluginComponentsCache()
})

afterEach(() => {
  const currentCacheDir = getOmoOpenCodeCacheDir()

  for (const key of Object.keys(process.env)) {
    if (!(key in environmentSnapshot)) {
      delete process.env[key]
    }
  }

  for (const [key, value] of Object.entries(environmentSnapshot)) {
    if (value === undefined) {
      delete process.env[key]
      continue
    }

    process.env[key] = value
  }

  if (process.cwd() !== workingDirectorySnapshot) {
    process.chdir(workingDirectorySnapshot)
  }

  cleanupOmoCacheDir(currentCacheDir)
  cleanupOmoCacheDir(getOmoOpenCodeCacheDir())
  resetClaudeSessionState()
  resetTaskToastManager()
  resetModelFallbackState()
  resetConnectedProvidersCache()
  SessionCategoryRegistry.clear()
  clearSessionTools()
  clearAllSessionPromptParams()
  clearBackgroundOutputConsumptionState()
  clearVisionCapableModelsCache()
  resetLoggerForTesting()
  clearPluginComponentsCache()
  mock.restore()
  restoreModuleMocks()
})
