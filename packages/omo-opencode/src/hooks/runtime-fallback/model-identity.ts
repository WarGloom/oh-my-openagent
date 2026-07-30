import { parseModelString } from "../../shared/model-string-parser"
import { transformModelForProvider } from "../../shared/provider-model-id-transform"
import { stringifyRuntimeFallbackModel } from "./model-input"

export function modelIdentity(model: unknown): string | undefined {
  const modelString = stringifyRuntimeFallbackModel(model)
  if (!modelString) return undefined
  const parsed = parseModelString(modelString)
  if (parsed) {
    const modelID = transformModelForProvider(parsed.providerID, parsed.modelID)
    return `${parsed.providerID}/${modelID}`
  }
  return modelString.replace(/\([^()]+\)\s*$/, "").trim() || modelString
}
