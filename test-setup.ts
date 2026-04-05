import { beforeEach } from "bun:test"
import { _resetForTesting as resetClaudeSessionState } from "./src/features/claude-code-session-state/state"
import { _resetForTesting as resetModelFallbackState } from "./src/hooks/model-fallback/hook"
import { _resetMemCacheForTesting as resetConnectedProvidersCache } from "./src/shared/connected-providers-cache"
import { SessionCategoryRegistry } from "./src/shared/session-category-registry"
import { clearSessionTools } from "./src/shared/session-tools-store"
import { clearAllSessionPromptParams } from "./src/shared/session-prompt-params-state"
import { clearBackgroundOutputConsumptionState } from "./src/shared/background-output-consumption"
import { clearVisionCapableModelsCache } from "./src/shared/vision-capable-models-cache"
import { _resetForTesting as resetLoggerForTesting } from "./src/shared/logger"
import { clearPluginComponentsCache } from "./src/features/claude-code-plugin-loader/loader"

beforeEach(() => {
  resetClaudeSessionState()
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
