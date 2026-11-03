import type {
  V2AgentEditor,
  V2AgentInfo,
  V2AgentRecord,
  V2CommandDefinition,
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
  V2RetryHookEvent,
  V2IdleHookEvent,
  V2Event,
  V2ModelRef,
  V2McpEditor,
  V2McpServerConfig,
  V2ModelInfo,
  V2PluginContext,
  V2ProviderInfo,
  V2Registration,
  V2ToolInfo,
  V2ToolEditor,
} from "./context-types"

export type FakeContextOptions = {
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
}

export type FakeSessionCall =
  | { readonly kind: "prompt"; readonly input: V2PromptInput }
  | { readonly kind: "synthetic"; readonly input: V2SyntheticInput }
  | { readonly kind: "create"; readonly input: Parameters<V2SessionDomain["create"]>[0] }
  | { readonly kind: "remove"; readonly sessionID: string }
  | { readonly kind: "interrupt"; readonly sessionID: string }
  | { readonly kind: "compact"; readonly sessionID: string }
  | { readonly kind: "wait"; readonly sessionID: string }
  | { readonly kind: "switchAgent"; readonly sessionID: string; readonly agent: string }
  | { readonly kind: "switchModel"; readonly sessionID: string; readonly model: V2ModelRef }

export type FakePluginContext = {
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
  /** Everything the plugin asked the session API to do, in order. */
  readonly sessionCalls: ReadonlyArray<FakeSessionCall>
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
  readonly triggerRetry: (event: V2RetryHookEvent) => Promise<V2RetryHookEvent>
  readonly triggerIdle: (event: V2IdleHookEvent) => Promise<V2IdleHookEvent>
  readonly sessionHookCount: () => number
}

function fakeSessionInfo(id: string, options: FakeContextOptions, parentID?: string, title?: string): V2SessionInfo {
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
      add: (info) => {
        addedTools.push({ ...info })
      },
      list: () =>
        addedTools.map((info) => ({
          ...info,
          id: info.options?.namespace ? `${info.options.namespace}_${info.name}` : info.name,
        })),
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
  const sessionCalls: FakeSessionCall[] = []
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
  const retryHooks: Array<(event: V2RetryHookEvent) => Promise<void> | void> = []
  const idleHooks: Array<(event: V2IdleHookEvent) => Promise<void> | void> = []
  const sessionModels = new Map<string, V2ModelRef>()

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
    for (const transform of commandTransforms)
      transform({ add: (definition) => void commandsBuilt.set(definition.name, definition) })
  }

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
          while (queue.length === 0 && !closed && failure === undefined)
            await new Promise<void>((resolve) => (wake = resolve))
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

  const context: V2PluginContext = {
    app: { name: "cli", version: "2.0.28", channel: "latest" },
    location: {
      directory: options.directory ?? "/work/app",
      project: { id: "proj_1", directory: "/work/app", canonical: "/work/app" },
    },
    options: {},
    tool: {
      transform: async (callback) => {
        toolTransforms.push(callback)
        rebuildTools()
        return {
          dispose: async () => {
            toolTransforms.splice(toolTransforms.indexOf(callback), 1)
            rebuildTools()
          },
        }
      },
      list: async () =>
        addedTools.map((info) => ({
          ...info,
          id: info.options?.namespace ? `${info.options.namespace}_${info.name}` : info.name,
        })),
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
        events: {
          emit: async (name, data) => {
            for (const push of subscribers) push({ type: `rpc.${definition.id}.${name}`, data })
          },
        },
      }),
    },
    model: {
      list: async () => ({ data: options.models ?? [] }),
      default: async () => ({ data: options.defaultModel ?? null }),
    },
    provider: { list: async () => ({ data: options.providers ?? [] }) },
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
      get: async ({ sessionID }) => ({
        ...fakeSessionInfo(sessionID, options),
        ...(sessionModels.has(sessionID) ? { model: sessionModels.get(sessionID) } : {}),
      }),
      create: async (input) => {
        sessionCalls.push({ kind: "create", input })
        createdSessions += 1
        return fakeSessionInfo(
          `ses_created_${createdSessions}`,
          options,
          input.parentID ?? undefined,
          input.title ?? undefined,
        )
      },
      remove: async ({ sessionID }) => void sessionCalls.push({ kind: "remove", sessionID }),
      context: async () => options.sessionMessages ?? [],
      wait: async ({ sessionID }) => void sessionCalls.push({ kind: "wait", sessionID }),
      interrupt: async ({ sessionID }) => void sessionCalls.push({ kind: "interrupt", sessionID }),
      compact: async ({ sessionID }) => void sessionCalls.push({ kind: "compact", sessionID }),
      prompt: async (input) => void sessionCalls.push({ kind: "prompt", input }),
      synthetic: async (input) => void sessionCalls.push({ kind: "synthetic", input }),
      switchAgent: async (input) => void sessionCalls.push({ kind: "switchAgent", ...input }),
      switchModel: async (input) => {
        sessionModels.set(input.sessionID, input.model)
        sessionCalls.push({ kind: "switchModel", ...input })
      },
      hook: ((
        name: "prompt" | "context" | "model.request" | "compaction" | "retry" | "experimental.idle",
        callback: (event: never) => Promise<void> | void,
      ) => {
        const list = (
          name === "prompt"
            ? promptHooks
            : name === "context"
              ? contextHooks
              : name === "model.request"
                ? modelRequestHooks
                : name === "compaction"
                  ? compactionHooks
                  : name === "retry"
                    ? retryHooks
                    : idleHooks
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
  }

  return {
    context,
    addedTools,
    registration,
    builtAgents: () => built,
    defaultAgent: () => chosenDefault,
    builtMcp: () => mcpBuilt,
    mcpReloadCount: () => mcpReloads,
    builtCommands: () => commandsBuilt,
    commandReloadCount: () => commandReloads,
    sessionCalls,
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
      for (const hook of modelRequestHooks) await hook(event)
      return event
    },
    triggerCompaction: async (event) => {
      for (const hook of compactionHooks) await hook(event)
      return event
    },
    triggerRetry: async (event) => {
      for (const hook of retryHooks) await hook(event)
      return event
    },
    triggerIdle: async (event) => {
      for (const hook of idleHooks) await hook(event)
      return event
    },
    sessionHookCount: () =>
      promptHooks.length +
      contextHooks.length +
      modelRequestHooks.length +
      compactionHooks.length +
      retryHooks.length +
      idleHooks.length,
  }
}
