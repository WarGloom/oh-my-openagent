import { isRecord } from "@oh-my-opencode/utils/record-type-guard"

export function nativeAdmissionErrorFields(error: unknown) {
  return {
    error: error instanceof Error ? error.message || error.name : String(error),
    ...(isRecord(error) && typeof error._tag === "string" ? { _tag: error._tag } : {}),
    ...(isRecord(error) && typeof error.reason === "string" ? { reason: error.reason } : {}),
  }
}
