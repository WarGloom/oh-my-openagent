import { isRecord } from "@oh-my-opencode/utils"
import { getSessionPromptParams } from "../shared/session-prompt-params-state"
import { getModelCapabilities, isProviderUsingOAuth, log, resolveCompatibleModelSettings } from "../shared"

const SAFE_MAX_OUTPUT_TOKENS_FALLBACK = 4096

export type ChatParamsInput = {
  sessionID: string
  agent: { name?: string }
  model: { providerID: string; modelID: string }
  provider: { id: string }
  message: { variant?: string }
}

type ChatParamsHookInput = ChatParamsInput & {
  rawMessage?: Record<string, unknown>
}

export type ChatParamsOutput = {
  temperature?: number
  topP?: number
  topK?: number
  maxOutputTokens?: number
  options: Record<string, unknown>
}

type ExperimentalAnthropicAdvisorConfig = {
  enabled?: boolean
  advisor_model?: string
  max_uses?: number
  caching_ttl?: "5m" | "1h"
  agents?: string[]
  executor_models?: string[]
}

const DEFAULT_ADVISOR_MODEL = "claude-opus-4-7"
const DEFAULT_EXECUTOR_PATTERNS = [
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-opus-4-7",
] as const

function shouldDisableAnthropicThinking(providerID: string): boolean {
  return providerID === "anthropic" && isProviderUsingOAuth(providerID)
}

function stripProviderPrefix(modelID: string): string {
  const parts = modelID.split("/")
  return parts.length > 1 ? parts.slice(1).join("/") : modelID
}

function shouldEnableAnthropicAdvisor(
  input: ChatParamsInput,
  config: ExperimentalAnthropicAdvisorConfig | undefined,
): boolean {
  if (!config) return false
  if (config.enabled === false) return false
  if (input.model.providerID !== "anthropic") return false
  if (shouldDisableAnthropicThinking(input.model.providerID)) return false

  if (config.agents?.length && !config.agents.includes(input.agent.name ?? "")) {
    return false
  }

  const executorPatterns = config.executor_models?.length ? config.executor_models : DEFAULT_EXECUTOR_PATTERNS
  const modelID = stripProviderPrefix(input.model.modelID)
  return executorPatterns.some((pattern) => modelID.includes(stripProviderPrefix(pattern)))
}

function buildAnthropicAdvisorOptions(config: ExperimentalAnthropicAdvisorConfig): Record<string, unknown> {
  return {
    model: config.advisor_model ?? DEFAULT_ADVISOR_MODEL,
    ...(config.max_uses !== undefined ? { maxUses: config.max_uses } : {}),
    ...(config.caching_ttl ? { caching: { ttl: config.caching_ttl } } : {}),
  }
}

function buildChatParamsInput(raw: unknown): ChatParamsHookInput | null {
  if (!isRecord(raw)) return null

  const sessionID = raw.sessionID
  const agent = raw.agent
  const model = raw.model
  const provider = raw.provider
  const message = raw.message

  if (typeof sessionID !== "string") return null
  if (!isRecord(model)) return null
  if (!isRecord(provider)) return null
  if (!isRecord(message)) return null

  let agentName: string | undefined
  if (typeof agent === "string") {
    agentName = agent
  } else if (isRecord(agent)) {
    const name = agent.name
    if (typeof name === "string") {
      agentName = name
    }
  }
  if (!agentName) return null

  const providerID = model.providerID
  const modelID = typeof model.modelID === "string"
    ? model.modelID
    : typeof model.id === "string"
      ? model.id
      : undefined
  const providerId = provider.id
  if (typeof providerID !== "string") return null
  if (typeof modelID !== "string") return null
  if (typeof providerId !== "string") return null

  return {
    sessionID,
    agent: { name: agentName },
    model: { providerID, modelID },
    provider: { id: providerId },
    message,
    rawMessage: message,
  }
}

function isChatParamsOutput(raw: unknown): raw is ChatParamsOutput {
  if (!isRecord(raw)) return false
  if (!isRecord(raw.options)) {
    raw.options = {}
  }
  return isRecord(raw.options)
}

type ChatParamsHandlerArgs = {
  anthropicEffort?: { "chat.params"?: (input: ChatParamsHookInput, output: ChatParamsOutput) => Promise<void> } | null
  client?: unknown
  experimental?: {
    anthropicAdvisor?: ExperimentalAnthropicAdvisorConfig
  }
}

export function createChatParamsHandler(args: ChatParamsHandlerArgs = {}): (input: unknown, output: unknown) => Promise<void> {
  return async (input, output): Promise<void> => {
    const normalizedInput = buildChatParamsInput(input)
    if (!normalizedInput) return
    if (!isChatParamsOutput(output)) return

    const storedPromptParams = getSessionPromptParams(normalizedInput.sessionID)
    if (storedPromptParams) {
      if (storedPromptParams.temperature !== undefined) {
        output.temperature = storedPromptParams.temperature
      }
      if (storedPromptParams.topP !== undefined) {
        output.topP = storedPromptParams.topP
      }
      if (
        typeof storedPromptParams.maxOutputTokens === "number" &&
        storedPromptParams.maxOutputTokens > 0
      ) {
        (output as Record<string, unknown>).maxOutputTokens = storedPromptParams.maxOutputTokens
      }
      if (storedPromptParams.options) {
        output.options = {
          ...output.options,
          ...storedPromptParams.options,
        }
      }
    }

    const capabilities = getModelCapabilities({
      providerID: normalizedInput.model.providerID,
      modelID: normalizedInput.model.modelID,
    })

    const compatibility = resolveCompatibleModelSettings({
      providerID: normalizedInput.model.providerID,
      modelID: normalizedInput.model.modelID,
      desired: {
        variant: typeof normalizedInput.message.variant === "string"
          ? normalizedInput.message.variant
          : undefined,
        reasoningEffort: typeof output.options.reasoningEffort === "string"
          ? output.options.reasoningEffort
          : undefined,
        temperature: typeof output.temperature === "number" ? output.temperature : undefined,
        topP: typeof output.topP === "number" ? output.topP : undefined,
        maxTokens: typeof output.maxOutputTokens === "number" ? output.maxOutputTokens : undefined,
        thinking: isRecord(output.options.thinking) ? output.options.thinking : undefined,
      },
      capabilities,
    })

    if (normalizedInput.rawMessage) {
      if (compatibility.variant !== undefined) {
        normalizedInput.rawMessage.variant = compatibility.variant
      } else {
        delete normalizedInput.rawMessage.variant
      }
    }
    normalizedInput.message = normalizedInput.rawMessage as { variant?: string }

    if (compatibility.reasoningEffort !== undefined) {
      output.options.reasoningEffort = compatibility.reasoningEffort
    } else if ("reasoningEffort" in output.options) {
      delete output.options.reasoningEffort
    }

    if ("temperature" in compatibility) {
      if (compatibility.temperature !== undefined) {
        output.temperature = compatibility.temperature
      } else {
        delete output.temperature
      }
    }

    if ("topP" in compatibility) {
      if (compatibility.topP !== undefined) {
        output.topP = compatibility.topP
      } else {
        delete output.topP
      }
    }

    if ("maxTokens" in compatibility) {
      if (compatibility.maxTokens !== undefined && compatibility.maxTokens > 0) {
        output.maxOutputTokens = compatibility.maxTokens
      } else {
        const originalMaxOutputTokens = typeof output.maxOutputTokens === "number"
          ? output.maxOutputTokens
          : compatibility.maxTokens
        output.maxOutputTokens = SAFE_MAX_OUTPUT_TOKENS_FALLBACK
        if (typeof originalMaxOutputTokens === "number" && originalMaxOutputTokens <= 0) {
          log(
            `[plugin] maxOutputTokens=${originalMaxOutputTokens} is non-positive; using safe fallback ${SAFE_MAX_OUTPUT_TOKENS_FALLBACK}`,
          )
        }
      }
    }

    if ("thinking" in compatibility) {
      if (compatibility.thinking !== undefined) {
        output.options.thinking = compatibility.thinking
      } else {
        delete output.options.thinking
      }
    }
    if (output.options.thinking !== undefined && shouldDisableAnthropicThinking(normalizedInput.model.providerID)) {
      delete output.options.thinking
      log("chat-params: dropped thinking for anthropic oauth session", {
        sessionID: normalizedInput.sessionID,
        provider: normalizedInput.model.providerID,
        model: normalizedInput.model.modelID,
      })
    }

    if (
      output.options.anthropicAdvisor === undefined
      && shouldEnableAnthropicAdvisor(normalizedInput, args.experimental?.anthropicAdvisor)
      && args.experimental?.anthropicAdvisor
    ) {
      output.options.anthropicAdvisor = buildAnthropicAdvisorOptions(args.experimental.anthropicAdvisor)
    }
  }
}
