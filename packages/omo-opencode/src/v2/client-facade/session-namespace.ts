import type { V2ModelRef, V2PermissionRule, V2PluginContext } from "../context-types"
import { normalizeAction } from "../config-bridge"
import type { SessionTracker } from "../session-tracker"
import { createPromptAsync, type PromptAsyncArgs } from "./prompt-async"
import { toV1Session } from "./to-v1-session"
import { translateMessages } from "./translate-messages"
import type { V1Message } from "./v1-message-types"
import { settle, v1Error, type V1Result } from "./v1-result"
import { deliverMailboxV2 } from "@oh-my-opencode/team-core/team-mailbox"
import type { TeamModeConfig } from "../../config/schema/team-mode"
import { readSessionTodos } from "../session-todos"

type SessionRef = { readonly path: { readonly id: string } }

type CreateBody = {
  readonly parentID?: string
  readonly title?: string
  readonly model?: { readonly providerID: string; readonly modelID?: string; readonly id?: string; readonly variant?: string }
  readonly permission?: ReadonlyArray<{ readonly permission: string; readonly action: V2PermissionRule["effect"]; readonly pattern: string }>
}

export type SessionNamespaceDeps = {
  readonly tracker: SessionTracker
  readonly warn: (message: string) => void
}

function toV2Model(model: NonNullable<CreateBody["model"]>): V2ModelRef | undefined {
  const id = model.id ?? model.modelID
  if (id === undefined) return undefined
  return { providerID: model.providerID, id, ...(model.variant ? { variant: model.variant } : {}) }
}

/**
 * `client.session.*` in the 1.x shape, on the 2.x session domain. Reads come from `session.context`
 * translated by `translateMessages`; busy state comes from the event-fed tracker. Calls with no
 * 2.x counterpart (children, fork, revert, ...) are not defined here and fail loudly.
 */
export function createSessionNamespace(context: V2PluginContext, deps: SessionNamespaceDeps) {
  const reported = new Set<string>()
  const report = (key: string, message: string) => {
    if (reported.has(key)) return
    reported.add(key)
    deps.warn(message)
  }
  const worktree = context.location.project.canonical
  const promptAsync = createPromptAsync(context, report)

  const loadMessages = async (sessionID: string): Promise<V1Message[]> => {
    const [info, log] = await Promise.all([context.session.get({ sessionID }), context.session.context({ sessionID })])
    return translateMessages({
      messages: log,
      sessionID,
      directory: info.location.directory,
      worktree,
      initial: { agent: info.agent ?? "", ...(info.model === undefined ? {} : { model: info.model }) },
    })
  }

  return {
    list: (args: { readonly query?: { readonly directory?: string; readonly parentID?: string | null; readonly parent?: string; readonly limit?: number } } = {}) =>
      settle(async () => {
        const query = args.query
        const parentID = query?.parentID === undefined ? query?.parent : query.parentID
        const sessions = []
        let cursor: string | null | undefined
        do {
          const page = await context.session.list({
            ...(query?.directory === undefined ? {} : { directory: query.directory }),
            ...(parentID === undefined ? {} : { parentID }),
            ...(query?.limit === undefined ? {} : { limit: query.limit - sessions.length }),
            ...(cursor == null ? {} : { cursor }),
          })
          sessions.push(...page.data.map(toV1Session))
          cursor = page.cursor.next
        } while (cursor && (query?.limit === undefined || sessions.length < query.limit))
        return sessions
      }),

    messages: async (args: SessionRef & { readonly query?: { readonly limit?: number; readonly before?: string } }) => {
      const result = await settle(async () => {
        const all = await loadMessages(args.path.id)
        const before = args.query?.before
        const end = before === undefined ? all.length : all.findIndex((message) => message.info.id === before)
        if (end < 0) throw new Error(`Message cursor not found: ${before}`)
        const limit = args.query?.limit
        const start = typeof limit === "number" && limit > 0 ? Math.max(0, end - limit) : 0
        const data = all.slice(start, end)
        const headers = new Headers()
        if (start > 0 && data[0] !== undefined) headers.set("x-next-cursor", data[0].info.id)
        return { data, response: new Response(null, { headers }) }
      })
      return result.error === undefined ? result.data : result
    },

    message: async (args: { readonly path: { readonly id: string; readonly messageID: string } }): Promise<V1Result<V1Message>> => {
      const loaded = await settle(() => loadMessages(args.path.id))
      if (loaded.error !== undefined) return loaded
      const found = loaded.data.find((message) => message.info.id === args.path.messageID)
      return found === undefined ? v1Error("NotFoundError", `Message not found: ${args.path.messageID}`) : { data: found }
    },

    get: (args: SessionRef) => settle(async () => toV1Session(await context.session.get({ sessionID: args.path.id }))),
    update: (args: SessionRef & { readonly body?: { readonly title?: string; readonly permission?: CreateBody["permission"] } }) => settle(async () => {
      await context.session.update({ sessionID: args.path.id,
        ...(args.body?.title === undefined ? {} : { title: args.body.title }),
        ...(args.body?.permission === undefined ? {} : { permissions: args.body.permission.map((rule) => ({ action: normalizeAction(rule.permission), resource: rule.pattern, effect: rule.action })) }),
      })
      return toV1Session(await context.session.get({ sessionID: args.path.id }))
    }),

    create: (args: { readonly body?: CreateBody; readonly query?: { readonly directory?: string } } = {}) =>
      settle(async () => {
        const body = args.body ?? {}
        const model = body.model === undefined ? undefined : toV2Model(body.model)
        const directory = args.query?.directory
        const info = await context.session.create({
          parentID: body.parentID ?? null,
          title: body.title ?? null,
          ...(model === undefined ? {} : { model }),
          ...(directory === undefined || directory === context.location.directory ? {} : { location: { directory } }),
          ...(body.permission === undefined
            ? {}
            : { permissions: body.permission.map((rule) => ({ action: normalizeAction(rule.permission), resource: rule.pattern, effect: rule.action })) }),
        })
        return toV1Session(info)
      }),

    delete: (args: SessionRef) => settle(async () => (await context.session.remove({ sessionID: args.path.id }), true)),
    abort: (args: SessionRef) => settle(async () => (await context.session.interrupt({ sessionID: args.path.id }), true)),
    summarize: (args: SessionRef & { readonly body?: unknown }) => settle(async () => (await context.session.compact({ sessionID: args.path.id }), true)),

    promptAsync,
    prompt: async (args: PromptAsyncArgs): Promise<V1Result<V1Message>> => {
      const previous = await settle(() => loadMessages(args.path.id))
      if (previous.error !== undefined) return previous
      const previousIDs = new Set(previous.data.map((message) => message.info.id))
      const admitted = await promptAsync(args)
      if (admitted.error !== undefined) return admitted
      return settle(async () => {
        if (args.body?.noReply !== true) await context.session.wait({ sessionID: args.path.id })
        const messages = await loadMessages(args.path.id)
        const response = messages.findLast((message) => !previousIDs.has(message.info.id)
          && message.info.role === (args.body?.noReply === true ? "user" : "assistant"))
        if (response === undefined) throw new Error("OpenCode 2.x prompt completed without a new response")
        return response
      })
    },
    nativeTeamMailbox: (input: { readonly teamRunId: string; readonly memberName: string; readonly sessionID: string; readonly config: TeamModeConfig }) =>
      deliverMailboxV2({ ...input, admit: async (message) => { await context.session.synthetic({ ...message, delivery: "steer", resume: true }) } }),

    status: async () => ({ data: deps.tracker.statuses() }),

    todo: (args: SessionRef) => settle(() => readSessionTodos(context, args.path.id)),
  }
}
