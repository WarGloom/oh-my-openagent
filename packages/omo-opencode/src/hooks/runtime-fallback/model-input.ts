export type RuntimeFallbackModelInput = string | { providerID: string; modelID: string }

export function stringifyRuntimeFallbackModel(model: unknown): string | undefined {
  if (typeof model === "string") {
    const trimmed = model.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }

  if (!model || typeof model !== "object") {
    return undefined
  }

  const candidate = model as Record<string, unknown>
  const providerID = typeof candidate.providerID === "string" ? candidate.providerID.trim() : ""
  const modelID = typeof candidate.modelID === "string" ? candidate.modelID.trim() : ""

  if (!providerID || !modelID) {
    return undefined
  }

  return `${providerID}/${modelID}`
}
