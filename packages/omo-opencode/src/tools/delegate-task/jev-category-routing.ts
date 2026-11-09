import { createHash, randomUUID } from "node:crypto"
import type { CategoryConfig, JevRoutingConfig } from "../../config/schema"
import { MODEL, parseJevCategoryResponse, questions } from "./jev-router-model"
import { applyJevDecisionRule, selectJevArtifact } from "./jev-router-artifacts"
import { buildJevState } from "./jev-router-state"
import { recordJevRouting, type JevDecisionRecord } from "./jev-routing-ledger"
import { warnJevRouting } from "../../shared/jev-routing-health"
import { runWithAbortBudget } from "../../shared/abort-budget"

export type JevCategoryInput = {
  readonly brief: string
  readonly description?: string
  readonly directory?: string
  readonly resolveDirectory?: () => Promise<string>
  readonly config: JevRoutingConfig | undefined
  readonly enabledCategories: Readonly<Record<string, CategoryConfig>>
  readonly modelRouting?: false
  readonly signal?: AbortSignal
  readonly orchestratorCategory?: string
  readonly decisionId?: string
  readonly parentSessionId?: string
  readonly surface?: "task" | "team"
  readonly configGeneration?: string
  readonly onFallback?: (reason: string, category: string) => void
}

export function getCategoryRoutingEligibility(input: Pick<JevCategoryInput, "config" | "enabledCategories">) {
  const fallback = input.config?.default
  const validDefault =
    fallback !== undefined &&
    fallback !== "auto" &&
    !["__proto__", "constructor", "prototype"].includes(fallback) &&
    Object.hasOwn(input.enabledCategories, fallback) &&
    input.enabledCategories[fallback] !== undefined
  return { valid: validDefault, validDefault }
}

async function readJevResponse(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length")
  if (contentLength !== null && Number(contentLength) > 65536) {
    await response.body?.cancel()
    throw new RangeError("Response exceeds bound")
  }
  const reader = response.body?.getReader()
  if (!reader) throw new RangeError("Missing response body")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 65536) {
        await reader.cancel()
        throw new RangeError("Response exceeds bound")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))
}

export async function routeCategoryWithJev(input: JevCategoryInput): Promise<string | undefined> {
  input.signal?.throwIfAborted()
  const config = input.config
  const fallback = getCategoryRoutingEligibility(input).validDefault ? config?.default : undefined
  if (!config || config.mode === "off") return fallback
  const explicit =
    input.orchestratorCategory !== undefined &&
    input.orchestratorCategory !== "auto" &&
    input.orchestratorCategory !== "omitted"
  const mode = explicit || config.mode === "observe" ? "observe" : "active"
  const decisionId = input.decisionId ?? randomUUID()
  const artifact = selectJevArtifact(config.artifact_id)
  const apiKey = process.env[config.api_key_env]
  const backend = apiKey ? "typesafe" : "zen"
  const model = config.model === "jev-latest" ? MODEL : config.model
  const started = performance.now()
  let chosen = explicit ? input.orchestratorCategory : fallback
  let error: JevDecisionRecord["error"] = "state_error"
  let result: ReturnType<typeof parseJevCategoryResponse> | undefined
  let answeredModel: string | null = null
  let briefStatus: JevDecisionRecord["brief_status"] = "none"
  const reasons: JevDecisionRecord["reason_codes"] = input.brief.trim() ? [] : ["empty_prompt"]
  try {
    if (!artifact) {
      error = "unknown_artifact"
      void warnJevRouting("unknown_artifacts")
      return chosen
    }
    if (!explicit && !fallback) {
      error = "invalid_config"
      return undefined
    }
    if (input.modelRouting === false && !explicit) {
      error = "disabled"
      return fallback
    }
    const directory = input.resolveDirectory
      ? await runWithAbortBudget({ timeoutMs: config.timeout_ms, signal: input.signal, run: input.resolveDirectory })
      : (input.directory ?? process.cwd())
    const built = await buildJevState({ prompt: input.brief, description: input.description ?? "", directory })
    briefStatus = built.briefStatus
    if (briefStatus === "unresolved") reasons.push("referenced_brief_unresolved", ...built.briefReasons)
    input.signal?.throwIfAborted()
    const body = JSON.stringify({ model, state: built.state, questions: questions() })
    if (Buffer.byteLength(body) + 2048 > 65536) {
      error = "oversized_request"
      return chosen
    }
    error = "unavailable"
    const timeout = AbortSignal.timeout(config.timeout_ms)
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
    const response = await fetch(
      apiKey ? "https://api.typesafe.ai/v1/systemone" : "https://opencode.ai/zen/v1/systemone",
      {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body,
        signal,
      },
    )
    if (!response.ok) {
      error = "http_error"
      await response.body?.cancel()
      return chosen
    }
    error = "malformed"
    const parsed = parseJevCategoryResponse(await readJevResponse(response), artifact.router)
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(parsed.model)) throw new RangeError("Invalid response model identifier")
    answeredModel = parsed.model
    if (parsed.model !== model) {
      error = "model_mismatch"
      void warnJevRouting("model_mismatches")
      return chosen
    }
    result = parsed
    const selected = applyJevDecisionRule(result.ranking, artifact.rule)
    if (!Object.hasOwn(input.enabledCategories, selected) || input.enabledCategories[selected] === undefined) {
      error = "category_unavailable"
      return chosen
    }
    error = null
    if (mode === "active") chosen = selected
    return chosen
  } catch (cause) {
    if (!(cause instanceof Error)) throw cause
    if (input.signal?.aborted) error = "cancelled"
    else if (cause.name === "TimeoutError" || cause.name === "AbortError") error = "unavailable"
    return chosen
  } finally {
    if (!explicit && error && fallback && chosen === fallback && error !== "disabled" && error !== "cancelled")
      input.onFallback?.(error, fallback)
    recordJevRouting({
      schema_version: 1,
      event_id: randomUUID(),
      decision_id: decisionId,
      event: "decision",
      timestamp: new Date().toISOString(),
      parent_session_id: input.parentSessionId ?? null,
      parent_decision_id: null,
      surface: input.surface ?? "task",
      mode,
      orchestrator_category: input.orchestratorCategory ?? "auto",
      chosen_category: chosen ?? null,
      top1: result?.ranking[0] ?? null,
      top2: result?.ranking[1] ?? null,
      answers: result?.answers ?? null,
      artifact_id: artifact?.artifact_id ?? (/^[0-9a-f]{64}$/.test(config.artifact_id) ? config.artifact_id : null),
      jev_model_id: answeredModel,
      latency_ms: Math.round(performance.now() - started),
      input_tokens: result?.inputTokens ?? null,
      backend,
      error,
      brief_status: briefStatus,
      would_block: reasons.includes("empty_prompt") || reasons.includes("referenced_brief_unresolved"),
      reason_codes: reasons,
      config_generation:
        input.configGeneration ?? createHash("sha256").update(JSON.stringify(input.enabledCategories)).digest("hex"),
      brief_sha256: createHash("sha256").update(input.brief).digest("hex"),
      brief_bytes: Buffer.byteLength(input.brief),
    })
    input.signal?.throwIfAborted()
  }
}
