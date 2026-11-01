import type { V2SessionMessage } from "./context-types"
import type { V1MessageView } from "./messages-transform-bridge"

export function enrichMessageViews(views: V1MessageView[], history: ReadonlyArray<V2SessionMessage>): void {
  const records = new Map(history.map((record) => [record.id, record]))
  for (const view of views) {
    if (view.info.role !== "user" || typeof view.info.id !== "string") continue
    const record = records.get(view.info.id)
    if (record?.type !== "user" && record?.type !== "synthetic") continue
    const textParts = view.parts.filter((part) => part.type === "text")
    for (const part of textParts) {
      if (record.type === "synthetic") part.synthetic = true
      if (record.metadata !== undefined && textParts.length === 1) part.metadata = record.metadata
    }
  }
}
