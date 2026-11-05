import { createHash, randomUUID } from "node:crypto"
import type { PluginInput } from "@opencode-ai/plugin"
import type { InternalPromptDispatchResult } from "../shared/prompt-async-gate"
import type { V2IdleHookEvent, V2PluginContext, V2Registration } from "./context-types"

export type NativeIdleEvent = Omit<V2IdleHookEvent, "background"> & {
  readonly background: readonly (V2IdleHookEvent["background"][number] & { readonly wakes?: boolean })[]
  readonly admit: (input: { readonly id: string; readonly text: string; readonly description?: string }) => Promise<"admitted" | "duplicate" | "stale">
}

type Boundary = {
  readonly event: NativeIdleEvent
  readonly id: string
  readonly waking: boolean
  readonly anchorID: string | undefined
  active: boolean
  settledID?: string
}

export type NativeIdleArbiterDeps = {
  readonly isNativeRecoveryPending: (sessionID: string) => boolean
  readonly settleCompactionRestore: (sessionID: string) => Promise<void>
  readonly hasPendingWork: (sessionID: string) => boolean
}

type IdleListener = (event: V2IdleHookEvent) => Promise<void> | void

/** Uses the synchronous boundary in its hook and semantic succeeded-idle admission after settlement. */
export class NativeIdleArbiter {
  private readonly listeners = new Set<IdleListener>()
  private readonly boundaries = new Map<string, Boundary>()
  private registration?: V2Registration

  constructor(
    private readonly context: Pick<V2PluginContext, "session" | "experimental">,
    private readonly deps: NativeIdleArbiterDeps,
  ) {}

  async start(): Promise<void> {
    if (this.registration) return
    this.registration = await this.context.session.hook("experimental.idle", async (event) => {
      const boundary: Boundary = {
        event,
        id: `msg_${randomUUID().replaceAll("-", "")}`,
        anchorID: (await this.context.session.context({ sessionID: event.sessionID })).at(-1)?.id,
        active: true,
        waking: event.background.some((work) => work.sessionID === event.sessionID
          && (work.kind !== "subagent" || !("wakes" in work) || work.wakes !== false)),
      }
      this.boundaries.set(event.sessionID, boundary)
      try {
        for (const listener of this.listeners) await listener(event)
      } finally {
        boundary.active = false
      }
    })
  }

  onIdle(listener: IdleListener): V2Registration {
    this.listeners.add(listener)
    return { dispose: async () => void this.listeners.delete(listener) }
  }

  async admit(sessionID: string, text: string, source: string): Promise<InternalPromptDispatchResult> {
    const boundary = this.boundaries.get(sessionID)
    if (!boundary || boundary.waking || this.deps.isNativeRecoveryPending(sessionID) || this.deps.hasPendingWork(sessionID)) return { status: "active" }
    await this.deps.settleCompactionRestore(sessionID)
    if (this.boundaries.get(sessionID) !== boundary || this.deps.isNativeRecoveryPending(sessionID) || this.deps.hasPendingWork(sessionID)) return { status: "active" }
    try {
      const id = `msg_${createHash("sha256").update(`${boundary.id}:${source}`).digest("hex").slice(0, 26)}`
      const request = { id, text, description: source }
      const outcome = boundary.active
        ? await boundary.event.admit(request)
        : await this.admitSettled(sessionID, boundary, request)
      // The host checks pending resume:false input, interruption and work admission atomically.
      return outcome === "stale" ? { status: "cancelled" } : { status: "dispatched", response: outcome }
    } catch (error) {
      return { status: "failed", error, dispatchAttempted: true }
    }
  }

  private async admitSettled(sessionID: string, boundary: Boundary, input: Parameters<NativeIdleEvent["admit"]>[0]) {
    if (!boundary.settledID) {
      const history = await this.context.session.context({ sessionID })
      const anchor = history.findIndex((message) => message.id === boundary.anchorID)
      const settled = anchor < 0 ? undefined : history[anchor + 1]
      if (settled?.type !== "idle" || settled.outcome !== "succeeded" || history.at(-1)?.id !== settled.id) return "stale"
      boundary.settledID = settled.id
    }
    if (this.boundaries.get(sessionID) !== boundary || this.deps.isNativeRecoveryPending(sessionID) || this.deps.hasPendingWork(sessionID)) return "stale"
    return this.context.experimental.session.continueAfterIdle({ sessionID, boundaryID: boundary.settledID, ...input })
  }

  forget(sessionID: string): void {
    this.boundaries.delete(sessionID)
  }

  async dispose(): Promise<void> {
    this.listeners.clear()
    this.boundaries.clear()
    await this.registration?.dispose()
    this.registration = undefined
  }
}

const arbiters = new WeakMap<PluginInput, NativeIdleArbiter>()

export function bindNativeIdleArbiter(input: PluginInput, arbiter: NativeIdleArbiter): void {
  arbiters.set(input, arbiter)
}

export function getNativeIdleArbiter(input: PluginInput): NativeIdleArbiter | undefined {
  return arbiters.get(input)
}
