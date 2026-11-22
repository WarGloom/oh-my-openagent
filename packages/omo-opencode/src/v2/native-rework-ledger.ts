import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { Hooks } from "@opencode-ai/plugin"
import { recordJevRouting } from "../tools/delegate-task/jev-routing-ledger"
import { classifyRework } from "../tools/delegate-task/jev-rework-classifier"
import { extractTaskLink } from "../features/tool-metadata-store"
import { findRegisteredBackgroundTaskBySession } from "../features/background-agent/task-registry"
import { isRecord } from "../shared/record-type-guard"
import type { V2PluginContext, V2Registration, V2ToolAfterEvent, V2SessionMessage } from "./context-types"
import { installJevMcpLedger } from "./jev-mcp-ledger"
import { sha256 } from "./reply-check-ledger"

const enabled = new WeakSet<Hooks>()
const pending = new WeakMap<V2PluginContext, Map<string, string>>()
const callKey = (session: string, id: string) => JSON.stringify([session, id])
export const bindNativeRework = (hooks: Hooks) => enabled.add(hooks)
export function noteNativeDecision(context: V2PluginContext, sessionID: string, callID: string, decision: string) {
  const calls = pending.get(context)
  calls?.set(callKey(sessionID, callID), decision)
  if (calls && calls.size > 512) calls.delete(calls.keys().next().value ?? "")
}
const saved = z.object({
  decision: z.uuid(),
  reports: z.number().int().nonnegative(),
  round: z.number().int().nonnegative(),
})
const reportMetadata = z.object({ source: z.literal("subagent"), childID: z.string().min(1), state: z.string() })
const digest = (text: string) => ({ text_sha256: sha256(text), text_bytes: Buffer.byteLength(text) })
const content = (result: V2ToolAfterEvent["result"]): string =>
  typeof result?.content === "string"
    ? result.content
    : (result?.content ?? [])
        .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
        .join("\n")

export async function installNativeRework(context: V2PluginContext, hooks: Hooks): Promise<V2Registration | undefined> {
  const storage = context.storage
  if (!enabled.has(hooks) || !storage) return
  const mcp = await installJevMcpLedger(context)
  const decisions = new Map<string, string>()
  pending.set(context, decisions)
  const abort = new AbortController()
  const serial = new Map<string, Promise<unknown>>()
  const reports = new Map<string, Promise<string | undefined>>()
  const keyFor = (parent: string, child: string) =>
    "jev-rework/" + encodeURIComponent(parent) + "/" + encodeURIComponent(child)
  const reportKey = (parent: string, id: string) =>
    "jev-rework-report/" + encodeURIComponent(parent) + "/" + encodeURIComponent(id)
  const fields = (parent: string, child: string, decision: string) => ({
    schema_version: 1 as const,
    timestamp: new Date().toISOString(),
    event_id: randomUUID(),
    decision_id: decision,
    parent_session_id: parent,
    child_session_id: child,
  })
  const read = async (parent: string, child: string) => saved.safeParse(await storage.get(keyFor(parent, child))).data
  const run = <T>(parent: string, child: string, work: () => Promise<T>) => {
    const key = keyFor(parent, child)
    const next = (serial.get(key) ?? Promise.resolve()).catch(() => {}).then(work)
    serial.set(key, next)
    const cleanup = () => {
      if (serial.get(key) === next) serial.delete(key)
    }
    void next.then(cleanup, cleanup)
    return next
  }
  const ensure = async (parent: string, child: string, decision?: string, category?: string) => {
    const previous = await read(parent, child)
    if (previous) return previous
    const task = findRegisteredBackgroundTaskBySession(child, parent)
    const state = { decision: decision ?? task?.decisionId ?? randomUUID(), reports: 0, round: 0 }
    await storage.set(keyFor(parent, child), state)
    void recordJevRouting({
      ...fields(parent, child, state.decision),
      event: "dispatch",
      category: category ?? task?.category ?? "named",
    })
    return state
  }
  const handleReport = (parent: string, message: V2SessionMessage) => {
    if (message.type !== "synthetic" || !message.text.startsWith('<background-result kind="subagent"')) return undefined
    const metadata = reportMetadata.safeParse(message.metadata)
    if (!metadata.success) return undefined
    const child = metadata.data.childID
    const identity = reportKey(parent, message.id)
    const current = reports.get(identity)
    if (current) return current
    const terminal = !/^<background-result [^\n]*\bstate="running"/.test(message.text)
    const reserved = run(parent, child, async () => {
      if (await storage.get(identity)) return undefined
      const state = await ensure(parent, child)
      await storage.set(keyFor(parent, child), { ...state, reports: state.reports + 1 })
      await storage.set(identity, true)
      return fields(parent, child, state.decision)
    })
    const result = reserved
      .then(async (link) => {
        if (!link) return undefined
        const [judgment, history] = await Promise.all([
          classifyRework("report", message.text),
          context.session.context({ sessionID: child }).catch(() => []),
        ])
        const producer = history.findLast(
          (entry) => entry.type === "assistant" && entry.time.created <= message.time.created,
        )
        const producing_model =
          producer?.type === "assistant" ? producer.model.providerID + "/" + producer.model.id : null
        void recordJevRouting({
          ...link,
          ...digest(message.text),
          ...judgment,
          event: "report",
          report_message_id: message.id,
          producing_model,
          terminal,
        })
        const probability = judgment.probabilities?.[judgment.classification] ?? 0
        if (
          terminal &&
          probability >= 0.7 &&
          (judgment.classification === "partial" || judgment.classification === "not_delivered")
        )
          return (
            "Worker report: " +
            (judgment.classification === "partial" ? "partly delivered" : "not delivered without a named blocker") +
            " (Jev " +
            probability.toFixed(2) +
            "). Ask the worker for the cause before replacing it."
          )
        return undefined
      })
      .catch(() => undefined)
    reports.set(identity, result)
    if (reports.size > 512) reports.delete(reports.keys().next().value ?? "")
    return result
  }
  const after = await context.tool.hook("execute.after", (event) => {
    if (event.tool !== "task" && event.tool !== "subagent") return
    const call = callKey(event.sessionID, event.id)
    const nativeDecision = decisions.get(call)
    decisions.delete(call)
    if (event.status !== "completed" || !isRecord(event.input) || typeof event.input.prompt !== "string") return
    const args = event.input
    const prompt = args.prompt
    if (typeof prompt !== "string") return
    const meta = event.result?.metadata
    const output = content(event.result)
    const link = extractTaskLink(meta, output)
    const child = link.sessionId
    if (!child) return
    const decisionValue = z.uuid().safeParse(meta?.decisionId)
    const decision = nativeDecision ?? decisionValue.data
    const parent = event.sessionID
    const continuation = typeof args.sessionID === "string" || typeof args.task_id === "string"
    const replacement = typeof args.replaces_session_id === "string" ? args.replaces_session_id : undefined
    const reserved = run(parent, child, async () => {
      const state = await ensure(parent, child, decision, link.category)
      if (!continuation || !state.reports) return { state }
      const round_index = state.round + 1
      await storage.set(keyFor(parent, child), { ...state, round: round_index })
      return { state, round_index }
    })
    void reserved
      .then(async ({ state, round_index }) => {
        if (round_index !== undefined) {
          const record = fields(parent, child, state.decision)
          const judgment = await classifyRework("round", prompt)
          void recordJevRouting({
            ...record,
            ...digest(prompt),
            ...judgment,
            event: "round",
            tool_call_id: event.id,
            round_index,
          })
        } else if (replacement && replacement !== child) {
          const previous = await run(parent, replacement, () => ensure(parent, replacement))
          void recordJevRouting({
            ...fields(parent, child, state.decision),
            event: "replacement",
            replaced_child_session_id: replacement,
            replaced_decision_id: previous.decision,
          })
        }
      })
      .catch(() => {})
  })
  const contextHook = await context.session.hook("context", async (event) => {
    const visible = new Map(
      event.messages.flatMap((message) => (typeof message.id === "string" ? [[message.id, message] as const] : [])),
    )
    if (visible.size === 0) return
    const history = await context.session.context({ sessionID: event.sessionID }).catch(() => [])
    const lastIdle = history.findLastIndex((message) => message.type === "idle")
    await Promise.all(
      history.slice(lastIdle + 1).map(async (message) => {
        const output = visible.get(message.id)
        if (!output) return
        const line = await handleReport(event.sessionID, message)
        if (!line) return
        if (typeof output.content === "string") output.content += "\n" + line
        else output.content.push({ type: "text", text: line })
      }),
    )
  })
  void (async () => {
    try {
      for await (const event of context.event.subscribe({ signal: abort.signal })) {
        if (
          event.type !== "session.inbox.delivered" ||
          !isRecord(event.data) ||
          typeof event.data.sessionID !== "string"
        )
          continue
        const { sessionID, inboxID } = event.data
        void context.session
          .context({ sessionID })
          .then((history) => {
            const message = history.find((entry) => entry.id === inboxID)
            if (message) void handleReport(sessionID, message)
          })
          .catch(() => {})
      }
    } catch {
      /* Delivery remains owned by the host. */
    }
  })()
  return {
    dispose: async () => {
      abort.abort()
      pending.delete(context)
      await contextHook.dispose()
      await after.dispose()
      await mcp.dispose()
    },
  }
}
