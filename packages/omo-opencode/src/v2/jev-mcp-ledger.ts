import { randomUUID } from "node:crypto"
import type { V2PluginContext, V2Registration } from "./context-types"
import { isRecord } from "../shared/record-type-guard"
import { recordJevRouting } from "../tools/delegate-task/jev-routing-ledger"
import { sha256 } from "./reply-check-ledger"

const tools = ["jev_verify", "jev_compare", "jev_audit"] as const
const nameOf = (value: string) => tools.find((tool) => value === tool || value === "jev_" + tool)
const text = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value ?? null))
function judgments(value: unknown): { verdict: string | null; probability: number | null }[] {
  if (Array.isArray(value)) return value.flatMap(judgments)
  if (!isRecord(value)) return []
  const label = value.verdict ?? value.relation
  const verdict = typeof label === "string" && /^[a-zA-Z_ -]{1,40}$/.test(label) ? label : null
  const score = value.probability ?? value.confidence ?? value.p_wrong
  const probability = typeof score === "number" && score >= 0 && score <= 1 ? score : null
  if (verdict === null && probability === null)
    return [value.results, value.records, value.aspects, value.checks, value.claims].flatMap(judgments)
  return [{ verdict, probability }]
}

export async function installJevMcpLedger(context: V2PluginContext): Promise<V2Registration> {
  const starts = new Map<string, number>()
  const before = await context.tool.hook("execute.before", (event) => {
    if (!nameOf(event.tool)) return
    starts.set(event.sessionID + ":" + event.id, performance.now())
    if (starts.size > 512) starts.delete(starts.keys().next().value ?? "")
  })
  const after = await context.tool.hook("execute.after", (event) => {
    const tool = nameOf(event.tool)
    if (!tool || !isRecord(event.input)) return
    const key = event.sessionID + ":" + event.id
    const start = starts.get(key) ?? performance.now()
    starts.delete(key)
    const claim = text(event.input.claims ?? event.input.passage_a ?? event.input.records)
    const evidence = text(event.input.evidence ?? event.input.passage_b ?? event.input.source)
    let output: unknown = event.result?.output
    if (output === undefined) {
      const content = event.result?.content
      const body = typeof content === "string" ? content : content?.find((part) => part.type === "text")?.text
      if (typeof body === "string") {
        try {
          output = JSON.parse(body)
        } catch {
          output = undefined
        }
      }
    }
    void recordJevRouting({
      schema_version: 1,
      event: "claim_check",
      decision_id: randomUUID(),
      event_id: randomUUID(),
      timestamp: new Date().toISOString(),
      parent_session_id: event.sessionID,
      tool_call_id: event.id,
      tool,
      claim_sha256: sha256(claim),
      claim_bytes: Buffer.byteLength(claim),
      evidence_sha256: sha256(evidence),
      evidence_bytes: Buffer.byteLength(evidence),
      judgments: judgments(output).slice(0, 128),
      latency_ms: performance.now() - start,
      status: event.status,
    })
  })
  return {
    dispose: async () => {
      await after.dispose()
      await before.dispose()
    },
  }
}
