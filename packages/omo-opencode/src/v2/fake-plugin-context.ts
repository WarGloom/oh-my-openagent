import type {
  V2AgentEditor,
  V2AgentInfo,
  V2AgentRecord,
  V2CommandDefinition,
  V2CommandBeforeEvent,
  V2ConfiguredModelInputs,
  V2PromptInput,
  V2SessionDomain,
  V2SessionInfo,
  V2SessionMessage,
  V2SyntheticInput,
  V2ToolAfterEvent,
  V2ToolBeforeEvent,
  V2PromptHookEvent,
  V2ContextHookEvent,
  V2ModelRequestHookEvent,
  V2CompactionHookEvent,
  V2CompactionContinueEvent,
  V2RetryHookEvent,
  V2IdleHookEvent,
  V2Event,
  V2ModelRef,
  V2McpEditor,
  V2McpServerConfig,
  V2ModelInfo,
  V2PermissionAssertInput,
  V2PluginContext,
  V2ProviderInfo,
  V2Registration,
  V2ToolInfo,
  V2ToolEditor,
  V2StorageDomain,
} from "./context-types"
import { createFakeProviderContext, type FakeProviderRecord, type FakeIntegrationRecord } from "./fake-provider-context"
import { createFakeSkillActivations, createFakeSkillDomain } from "./fake-skill-domain"
import type { V2SkillActivation, V2SkillInfo, V2SkillSnapshot, V2SubagentSkillsDomain } from "./native-skill-types"
import type { NativeSubagentDomain } from "./native-subagent-types"

let nextMessage = 0

export type FakeContextOptions = {
  readonly subagent?: NativeSubagentDomain
  readonly formatFile?: V2PluginContext["experimental"]["formatter"]["file"]
  readonly resolveVariants?: V2PluginContext["experimental"]["variant"]["resolve"]
  readonly acceptSubagentSkills?: V2SubagentSkillsDomain["acceptSkills"]
  readonly skillSnapshots?: ReadonlyArray<V2SkillSnapshot>
  readonly skills?: ReadonlyArray<V2SkillInfo>
  readonly configuredInputs?: ReadonlyArray<V2ConfiguredModelInputs>
  readonly models?: ReadonlyArray<V2ModelInfo>
  readonly providers?: ReadonlyArray<V2ProviderInfo>
  readonly agents?: ReadonlyArray<V2AgentInfo>
  readonly defaultModel?: V2ModelInfo | null
  readonly directory?: string
  /** The agent the fake session is currently on. */
  readonly sessionAgent?: string
  /** What `session.context` returns for any session. */
  readonly sessionMessages?: ReadonlyArray<V2SessionMessage>
  /** Fields merged over the fake session info returned by `session.get`. */
  readonly sessionInfo?: Partial<V2SessionInfo>
  /** When set, the fake `permission.assert` calls this; throw to simulate a denial. */
  readonly permissionAssert?: (input: V2PermissionAssertInput) => Promise<void>
  /** Integration ids that have a connection; mirrors the host's provider availability rule. */
  readonly connectedIntegrations?: ReadonlyArray<string>
}

export type FakeSessionCall =
  | { readonly kind: "prompt"; readonly input: V2PromptInput }
  | { readonly kind: "synthetic"; readonly input: V2SyntheticInput }
  | { readonly kind: "create"; readonly input: Parameters<V2SessionDomain["create"]>[0] }
  | { readonly kind: "update"; readonly input: Parameters<V2SessionDomain["update"]>[0] }
  | { readonly kind: "remove"; readonly sessionID: string }
  | { readonly kind: "interrupt"; readonly sessionID: string }
  | { readonly kind: "compact"; readonly sessionID: string }
  | { readonly kind: "wait"; readonly sessionID: string }
  | { readonly kind: "switchAgent"; readonly sessionID: string; readonly agent: string }
  | { readonly kind: "switchModel"; readonly sessionID: string; readonly model: V2ModelRef }

export type FakePluginContext = {
  readonly triggerSkillActivation: (event: V2SkillActivation) => Promise<V2SkillActivation>
  readonly context: V2PluginContext
  readonly addedTools: V2ToolInfo[]
  readonly registration: V2Registration
  /** The agents after the last time every registered agent transform ran against the host's base agents. */
  readonly builtAgents: () => ReadonlyMap<string, V2AgentRecord>
  readonly defaultAgent: () => string | undefined
  /** The MCP servers after the last time every registered MCP transform ran. */
  readonly builtMcp: () => ReadonlyMap<string, V2McpServerConfig>
  readonly mcpReloadCount: () => number
  readonly builtCommands: () => ReadonlyMap<string, V2CommandDefinition>
  readonly commandReloadCount: () => number
  readonly triggerCommandBefore: (event: V2CommandBeforeEvent) => Promise<V2CommandBeforeEvent>
  /** Provider definitions after the last provider fold, available or not. */
  readonly builtProviders: () => ReadonlyMap<string, FakeProviderRecord>
  readonly providerReloadCount: () => number
  readonly builtIntegrations: () => ReadonlyMap<string, FakeIntegrationRecord>
  readonly integrationReloadCount: () => number
  /** Everything the plugin asked the session API to do, in order. */
  readonly sessionCalls: ReadonlyArray<FakeSessionCall>
  readonly sessionHistory: (sessionID: string) => V2SessionMessage[]
  /** Every `permission.assert` input the plugin passed, in order. */
  readonly permissionCalls: ReadonlyArray<V2PermissionAssertInput>
  readonly reloadCount: () => number
  /** Delivers an event to every active `event.subscribe()` loop. */
  readonly emit: (event: V2Event) => void
  readonly activeSubscribers: () => number
  /** Makes every active `event.subscribe()` loop throw `error`, as the host does when it cannot encode an event. */
  readonly failSubscribers: (error: Error) => void
  /** Ends every active `event.subscribe()` loop normally, as the host does when it closes the stream. */
  readonly endSubscribers: () => void
  /** Runs the registered tool hooks in registration order and returns the event they mutated. */
  readonly triggerToolBefore: (event: V2ToolBeforeEvent) => Promise<V2ToolBeforeEvent>
  readonly triggerToolAfter: (event: V2ToolAfterEvent) => Promise<V2ToolAfterEvent>
  readonly toolHookCount: () => number
  /** Runs the registered session hooks in registration order and returns the event they mutated. */
  readonly triggerPrompt: (event: V2PromptHookEvent) => Promise<V2PromptHookEvent>
  readonly triggerContext: (event: V2ContextHookEvent) => Promise<V2ContextHookEvent>
  readonly triggerModelRequest: (event: V2ModelRequestHookEvent) => Promise<V2ModelRequestHookEvent>
  readonly triggerCompaction: (event: V2CompactionHookEvent) => Promise<V2CompactionHookEvent>
  readonly triggerCompactionContinue: (event: V2CompactionContinueEvent) => Promise<V2CompactionContinueEvent>
  readonly triggerRetry: (event: V2RetryHookEvent) => Promise<V2RetryHookEvent>
  readonly triggerIdle: (event: Omit<V2IdleHookEvent, "admit"> & Partial<Pick<V2IdleHookEvent, "admit">>) => Promise<V2IdleHookEvent>
  readonly sessionHookCount: () => number
}

function fakeSessionInfo(
  id: string,
  options: FakeContextOptions,
  parentID?: string,
  title?: string,
): V2SessionInfo {
  return {
    id,
    ...(parentID === undefined ? {} : { parentID }),
    projectID: "proj_1",
    ...(options.sessionAgent === undefined ? {} : { agent: options.sessionAgent }),
    ...(title === undefined ? {} : { title }),
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1_000, updated: 2_000 },
    location: { directory: options.directory ?? "/work/app" },
    ...options.sessionInfo,
  }
}

function toRecord(agent: V2AgentInfo): V2AgentRecord {
  return {
    id: agent.id,
    name: agent.name,
    ...(agent.model === undefined ? {} : { model: { ...agent.model } }),
    request: { settings: {}, headers: {}, body: {} },
    ...(agent.description === undefined ? {} : { description: agent.description }),
    mode: agent.mode,
    hidden: agent.hidden,
    ...(agent.color === undefined ? {} : { color: agent.color }),
    ...(agent.steps === undefined ? {} : { steps: agent.steps }),
    permissions: agent.permissions.map((rule) => ({ ...rule })),
  }
}

function defaultRecord(id: string): V2AgentRecord {
  return {
    id,
    name: id,
    request: { settings: {}, headers: {}, body: {} },
    mode: "primary",
    hidden: false,
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  }
}

/** A 2.x plugin context for unit tests. Not part of the shipped bundle: only tests import it. */
export function createFakePluginContext(options: FakeContextOptions = {}): FakePluginContext {
  const addedTools: V2ToolInfo[] = []
  const toolTransforms: Array<(editor: V2ToolEditor) => void> = []
  const rebuildTools = (): void => {
    addedTools.length = 0
    const editor: V2ToolEditor = {
      add: (info) => { addedTools.push({ ...info }) },
      list: () => addedTools.map((info) => ({ ...info, id: info.options?.namespace ? `${info.options.namespace}_${info.name}` : info.name })),
      update: (id, update) => {
        const index = editor.list().findIndex((tool) => tool.id === id)
        const info = addedTools[index]
        if (!info) return
        const draft = { ...info }
        update(draft)
        addedTools[index] = draft
      },
    }
    for (const transform of toolTransforms) transform(editor)
  }
  const registration: V2Registration = { dispose: async () => {} }
  const agentTransforms: Array<(editor: V2AgentEditor) => void> = []
  let built = new Map<string, V2AgentRecord>()
  let chosenDefault: string | undefined
  let reloads = 0
  const mcpTransforms: Array<(editor: V2McpEditor) => void> = []
  let mcpBuilt = new Map<string, V2McpServerConfig>()
  let mcpReloads = 0
  const commandTransforms: Array<(editor: { readonly add: (definition: V2CommandDefinition) => void }) => void> = []
  let commandsBuilt = new Map<string, V2CommandDefinition>()
  let commandReloads = 0
  const commandBeforeHooks: Array<(event: V2CommandBeforeEvent) => Promise<void> | void> = []
  const sessionCalls: FakeSessionCall[] = []
  const revisions = new Map<string, number>()
  const idleAdmissions = new Set<string>()
  const stored = new Map<string, Parameters<V2StorageDomain["set"]>[1]>()
  let createdSessions = 0
  const subscribers = new Set<(event: V2Event) => void>()
  const failers = new Set<(error: Error) => void>()
  const enders = new Set<() => void>()
  const beforeHooks: Array<(event: V2ToolBeforeEvent) => Promise<void> | void> = []
  const afterHooks: Array<(event: V2ToolAfterEvent) => Promise<void> | void> = []
  const promptHooks: Array<(event: V2PromptHookEvent) => Promise<void> | void> = []
  const contextHooks: Array<(event: V2ContextHookEvent) => Promise<void> | void> = []
  const modelRequestHooks: Array<(event: V2ModelRequestHookEvent) => Promise<void> | void> = []
  const compactionHooks: Array<(event: V2CompactionHookEvent) => Promise<void> | void> = []
  const compactionContinueHooks: Array<(event: V2CompactionContinueEvent) => Promise<void> | void> = []
  const retryHooks: Array<(event: V2RetryHookEvent) => Promise<void> | void> = []
  const idleHooks: Array<(event: V2IdleHookEvent) => Promise<void> | void> = []
  const sessionModels = new Map<string, V2ModelRef>()
  const recoveryAdmissions = new Set<string>()
  const pluginInterrupts = new Set<string>()
  const histories = new Map<string, V2SessionMessage[]>()
  const pending = new Set<string>()
  const history = (sessionID: string) => {
    const existing = histories.get(sessionID)
    if (existing) return existing
    const messages = [...options.sessionMessages ?? []]
    histories.set(sessionID, messages)
    return messages
  }

  const rebuildAgents = (): void => {
    built = new Map((options.agents ?? []).map((agent) => [agent.id, toRecord(agent)]))
    chosenDefault = undefined
    const editor: V2AgentEditor = {
      list: () => [...built.values()],
      get: (id) => built.get(id),
      default: (id) => {
        chosenDefault = id
      },
      update: (id, update) => {
        const current = built.get(id) ?? defaultRecord(id)
        built.set(id, current)
        update(current)
      },
      remove: (id) => void built.delete(id),
    }
    for (const transform of agentTransforms) transform(editor)
  }

  const rebuildMcp = (): void => {
    mcpBuilt = new Map()
    const editor: V2McpEditor = {
      list: () => [...mcpBuilt],
      get: (name) => mcpBuilt.get(name),
      set: (name, config) => void mcpBuilt.set(name, config),
      remove: (name) => void mcpBuilt.delete(name),
    }
    for (const transform of mcpTransforms) transform(editor)
  }

  const rebuildCommands = (): void => {
    commandsBuilt = new Map()
    for (const transform of commandTransforms) transform({ add: (definition) => void commandsBuilt.set(definition.name, definition) })
  }

  const providers = createFakeProviderContext(options)

  const subscribe = (subscribeOptions?: { readonly signal?: AbortSignal }): AsyncIterable<V2Event> => ({
    [Symbol.asyncIterator]() {
      const queue: V2Event[] = []
      let wake: (() => void) | undefined
      let closed = false
      let failure: Error | undefined
      const push = (event: V2Event): void => {
        queue.push(event)
        wake?.()
      }
      const fail = (error: Error): void => {
        failure = error
        wake?.()
      }
      subscribers.add(push)
      failers.add(fail)
      const close = (): void => {
        closed = true
        subscribers.delete(push)
        failers.delete(fail)
        enders.delete(close)
        wake?.()
      }
      enders.add(close)
      subscribeOptions?.signal?.addEventListener("abort", close, { once: true })
      if (subscribeOptions?.signal?.aborted) close()
      return {
        async next() {
          while (queue.length === 0 && !closed && failure === undefined) await new Promise<void>((resolve) => (wake = resolve))
          if (failure !== undefined) {
            const error = failure
            failure = undefined
            close()
            throw error
          }
          const event = queue.shift()
          return event === undefined ? { done: true, value: undefined } : { done: false, value: event }
        },
        async return() {
          close()
          return { done: true, value: undefined }
        },
      }
    },
  })

  const permissionCalls: V2PermissionAssertInput[] = []
  const skillDomain = createFakeSkillDomain(options.skills)
  const permission = { assert: async (input: V2PermissionAssertInput) => {
    permissionCalls.push(input)
    if (options.permissionAssert) await options.permissionAssert(input)
  } }
  const context: V2PluginContext = {
    experimental: {
      model: { configuredInputs: async () => options.configuredInputs ?? [] },
      formatter: { file: options.formatFile ?? (async () => false) },
      variant: { resolve: options.resolveVariants ?? (async () => []) },
      skill: createFakeSkillActivations({ domain: skillDomain, permission, snapshots: options.skillSnapshots ?? [], agent: options.sessionAgent ?? "sisyphus" }),
      subagent: {
        ...(options.subagent ?? {
          prepare: async () => { throw new Error("Native subagent owner is not configured") },
          start: async () => { throw new Error("Native subagent owner is not configured") },
          get: async () => undefined,
          wait: async () => { throw new Error("Native subagent owner is not configured") },
          cancel: async () => { throw new Error("Native subagent owner is not configured") },
          reconcile: async () => [],
          ready: async () => { throw new Error("Native subagent owner is not configured") },
        }),
        acceptSkills: options.acceptSubagentSkills ?? (async () => { throw new Error("Native subagent admission was not prepared") }),
      },
      session: {
        environment: async () => undefined,
        continueAfterIdle: async (input) => {
          const key = JSON.stringify([input.sessionID, input.id])
          if (idleAdmissions.has(key)) return "duplicate"
          const children = await context.experimental.subagent.reconcile({ parentSessionID: input.sessionID })
          const newest = history(input.sessionID).at(-1)
          if (newest?.id !== input.boundaryID || newest.type !== "idle" || newest.outcome !== "succeeded"
            || pending.has(input.sessionID) || children.some((child) => child.status === "prepared")) return "stale"
          idleAdmissions.add(key)
          pending.add(input.sessionID)
          revisions.set(input.sessionID, (revisions.get(input.sessionID) ?? 0) + 1)
          sessionCalls.push({ kind: "synthetic", input: { sessionID: input.sessionID, id: input.id, text: input.text, description: input.description, delivery: "steer", resume: true } })
          return "admitted"
        },
        recover: async ({ sessionID }, callback) => {
          const result = await context.experimental.session.interrupt({ sessionID })
          if (!result.interrupted || !result.boundaryID) return false
          try { return await callback({ boundaryID: result.boundaryID }) }
          finally { pluginInterrupts.delete(JSON.stringify([sessionID, result.boundaryID])) }
        },
        continueAfterFailure: async (input) => {
          const key = JSON.stringify([input.sessionID, input.id])
          if (recoveryAdmissions.has(key)) return "duplicate"
          const newest = history(input.sessionID).at(-1)
          const accepted = newest?.type === "idle" && (newest.outcome === "failed" || (newest.outcome === "interrupted" && pluginInterrupts.has(JSON.stringify([input.sessionID, newest.id]))))
          if (newest?.id !== input.boundaryID || !accepted || pending.has(input.sessionID)) return "stale"
          recoveryAdmissions.add(key)
          pending.add(input.sessionID)
          revisions.set(input.sessionID, (revisions.get(input.sessionID) ?? 0) + 1)
          if (input.model) {
            sessionModels.set(input.sessionID, input.model)
            sessionCalls.push({ kind: "switchModel", sessionID: input.sessionID, model: input.model })
          }
          sessionCalls.push({ kind: "synthetic", input: { sessionID: input.sessionID, id: input.id, text: input.text, description: input.description, delivery: "steer", resume: true } })
          return "admitted"
        },
        interrupt: async ({ sessionID }) => {
          await context.session.interrupt({ sessionID })
          const newest = history(sessionID).at(-1)
          if (newest?.type !== "idle" || newest.outcome !== "interrupted") return { interrupted: false }
          pluginInterrupts.add(JSON.stringify([sessionID, newest.id]))
          return { interrupted: true, boundaryID: newest.id }
        },
      },
    },
    app: { name: "cli", version: "2.0.28", channel: "latest" },
    location: {
      directory: options.directory ?? "/work/app",
      project: { id: "proj_1", directory: "/work/app", canonical: "/work/app" },
    },
    options: {},
    storage: {
      get: async (key) => structuredClone(stored.get(key)),
      set: async (key, value) => { stored.set(key, structuredClone(value)) },
      remove: async (key) => { stored.delete(key) },
      scan: async ({ prefix, after, limit }) => {
        const keys = [...stored.keys()].filter((key) => key.startsWith(prefix) && (after === undefined || key > after)).sort()
        const page = keys.slice(0, limit ?? keys.length)
        return {
          entries: page.map((key) => ({ key, value: structuredClone(stored.get(key)) })),
          ...(page.length < keys.length ? { next: page.at(-1) } : {}),
        }
      },
    },
    skill: skillDomain,
    tool: {
      transform: async (callback) => {
        toolTransforms.push(callback)
        rebuildTools()
        return { dispose: async () => {
          toolTransforms.splice(toolTransforms.indexOf(callback), 1)
          rebuildTools()
        } }
      },
      list: async () => addedTools.map((info) => ({ ...info, id: info.options?.namespace ? `${info.options.namespace}_${info.name}` : info.name })),
      hook: ((name: "execute.before" | "execute.after", callback: (event: never) => Promise<void> | void) => {
        const list = (name === "execute.before" ? beforeHooks : afterHooks) as Array<typeof callback>
        list.push(callback)
        return Promise.resolve({
          dispose: async () => {
            list.splice(list.indexOf(callback), 1)
          },
        })
      }) as V2PluginContext["tool"]["hook"],
    },
    rpc: {
      register: async (definition) => ({
        dispose: async () => {},
        events: { emit: async (name, data) => {
          for (const push of subscribers) push({ type: `rpc.${definition.id}.${name}`, data })
        } },
      }),
    },
    model: providers.model,
    provider: providers.provider,
    integration: providers.integration,
    agent: {
      list: async () => ({ data: options.agents ?? [] }),
      transform: async (callback) => {
        agentTransforms.push(callback)
        rebuildAgents()
        return {
          dispose: async () => {
            agentTransforms.splice(agentTransforms.indexOf(callback), 1)
            rebuildAgents()
          },
        }
      },
      reload: async () => {
        reloads += 1
        rebuildAgents()
      },
    },
    mcp: {
      transform: async (callback) => {
        mcpTransforms.push(callback)
        rebuildMcp()
        return {
          dispose: async () => {
            mcpTransforms.splice(mcpTransforms.indexOf(callback), 1)
            rebuildMcp()
          },
        }
      },
      reload: async () => {
        mcpReloads += 1
        rebuildMcp()
      },
    },
    command: {
      hook: async (_name, callback) => {
        commandBeforeHooks.push(callback)
        return { dispose: async () => { commandBeforeHooks.splice(commandBeforeHooks.indexOf(callback), 1) } }
      },
      transform: async (callback) => {
        commandTransforms.push(callback)
        rebuildCommands()
        return {
          dispose: async () => {
            commandTransforms.splice(commandTransforms.indexOf(callback), 1)
            rebuildCommands()
          },
        }
      },
      reload: async () => {
        commandReloads += 1
        rebuildCommands()
      },
    },
    session: {
      instructions: { entry: { put: async () => {}, remove: async () => {} } },
      list: async () => ({ data: [], cursor: {} }),
      get: async ({ sessionID }) => ({ ...fakeSessionInfo(sessionID, options), ...(sessionModels.has(sessionID) ? { model: sessionModels.get(sessionID) } : {}) }),
      update: async (input) => void sessionCalls.push({ kind: "update", input }),
      create: async (input) => {
        sessionCalls.push({ kind: "create", input })
        createdSessions += 1
        return fakeSessionInfo(`ses_created_${createdSessions}`, options, input.parentID ?? undefined, input.title ?? undefined)
      },
      remove: async ({ sessionID }) => void sessionCalls.push({ kind: "remove", sessionID }),
      context: async ({ sessionID }) => history(sessionID),
      wait: async ({ sessionID }) => void sessionCalls.push({ kind: "wait", sessionID }),
      interrupt: async ({ sessionID }) => {
        revisions.set(sessionID, (revisions.get(sessionID) ?? 0) + 1)
        sessionCalls.push({ kind: "interrupt", sessionID })
        history(sessionID).push({ type: "idle", id: `msg_fake_interrupt_${++nextMessage}`, outcome: "interrupted", time: { created: nextMessage } })
      },
      compact: async ({ sessionID }) => void sessionCalls.push({ kind: "compact", sessionID }),
      prompt: async (input) => {
        revisions.set(input.sessionID, (revisions.get(input.sessionID) ?? 0) + 1)
        pending.add(input.sessionID)
        sessionCalls.push({ kind: "prompt", input })
      },
      synthetic: async (input) => {
        revisions.set(input.sessionID, (revisions.get(input.sessionID) ?? 0) + 1)
        pending.add(input.sessionID)
        sessionCalls.push({ kind: "synthetic", input })
      },
      switchAgent: async (input) => void sessionCalls.push({ kind: "switchAgent", ...input }),
      switchModel: async (input) => {
        sessionModels.set(input.sessionID, input.model)
        sessionCalls.push({ kind: "switchModel", ...input })
      },
      hook: ((name: "prompt" | "context" | "model.request" | "compaction" | "experimental.compaction.continue" | "retry" | "experimental.idle", callback: (event: never) => Promise<void> | void) => {
        const list = (
          name === "prompt"
            ? promptHooks
            : name === "context"
              ? contextHooks
              : name === "model.request"
                ? modelRequestHooks
                : name === "compaction" ? compactionHooks : name === "experimental.compaction.continue" ? compactionContinueHooks : name === "retry" ? retryHooks : idleHooks
        ) as Array<typeof callback>
        list.push(callback)
        return Promise.resolve({
          dispose: async () => {
            list.splice(list.indexOf(callback), 1)
          },
        })
      }) as V2PluginContext["session"]["hook"],
    },
    event: { subscribe },
    permission,
  }

  return {
    triggerSkillActivation: skillDomain.activate,
    context,
    addedTools,
    registration,
    builtAgents: () => built,
    defaultAgent: () => chosenDefault,
    builtMcp: () => mcpBuilt,
    mcpReloadCount: () => mcpReloads,
    builtCommands: () => commandsBuilt,
    commandReloadCount: () => commandReloads,
    triggerCommandBefore: async (event) => {
      for (const hook of commandBeforeHooks) await hook(event)
      return event
    },
    builtProviders: providers.builtProviders,
    providerReloadCount: providers.providerReloadCount,
    builtIntegrations: providers.builtIntegrations,
    integrationReloadCount: providers.integrationReloadCount,
    sessionCalls,
    sessionHistory: history,
    permissionCalls,
    reloadCount: () => reloads,
    emit: (event) => {
      for (const push of subscribers) push(event)
    },
    activeSubscribers: () => subscribers.size,
    failSubscribers: (error) => {
      for (const fail of [...failers]) fail(error)
    },
    endSubscribers: () => {
      for (const end of [...enders]) end()
    },
    triggerToolBefore: async (event) => {
      for (const hook of beforeHooks) await hook(event)
      return event
    },
    triggerToolAfter: async (event) => {
      for (const hook of afterHooks) await hook(event)
      return event
    },
    toolHookCount: () => beforeHooks.length + afterHooks.length,
    triggerPrompt: async (event) => {
      for (const hook of promptHooks) await hook(event)
      return event
    },
    triggerContext: async (event) => {
      for (const hook of contextHooks) await hook(event)
      return event
    },
    triggerModelRequest: async (event) => {
      pending.delete(event.sessionID)
      for (const hook of modelRequestHooks) await hook(event)
      return event
    },
    triggerCompaction: async (event) => {
      for (const hook of compactionHooks) await hook(event)
      return event
    },
    triggerCompactionContinue: async (event) => {
      for (const hook of compactionContinueHooks) await hook(event)
      return event
    },
    triggerRetry: async (event) => {
      for (const hook of retryHooks) await hook(event)
      return event
    },
    triggerIdle: async (event) => {
      const revision = revisions.get(event.sessionID) ?? 0
      let active = true
      const idle: V2IdleHookEvent = { ...event, admit: event.admit ?? (async (input) => {
        const key = JSON.stringify([event.sessionID, input.id])
        if (idleAdmissions.has(key)) return "duplicate"
        if (!active || (revisions.get(event.sessionID) ?? 0) !== revision) return "stale"
        idleAdmissions.add(key)
        await context.session.synthetic({ ...input, sessionID: event.sessionID, resume: true })
        return "admitted"
      }) }
      try {
        for (const hook of idleHooks) await hook(idle)
      } finally {
        active = false
      }
      if ((revisions.get(event.sessionID) ?? 0) === revision) {
        history(event.sessionID).push({ type: "idle", id: `msg_fake_idle_${++nextMessage}`, outcome: "succeeded", time: { created: nextMessage } })
        revisions.set(event.sessionID, revision + 1)
      }
      return idle
    },
    sessionHookCount: () => promptHooks.length + contextHooks.length + modelRequestHooks.length + compactionHooks.length + compactionContinueHooks.length + retryHooks.length + idleHooks.length,
  }
}
