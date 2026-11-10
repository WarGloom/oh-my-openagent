import { z } from "zod"
import type { V2PluginContext, V2ToolExecuteContext, V2ToolResult } from "./context-types"
import { toPlainJsonSchema } from "./tool-bridge"
import { HandoffError, HandoffInput, SessionIdentity, type HandoffBinding } from "./session-handoff-types"

const Answer = z.object({ answers: z.array(z.array(z.string())) })

export function registerSessionHandoff(context: V2PluginContext) {
  const pending = new Map<string, { readonly binding: string; readonly result: Promise<V2ToolResult> }>()
  const execute = async (raw: unknown, invocation: V2ToolExecuteContext): Promise<V2ToolResult> => {
    const input = HandoffInput.parse(raw)
    invocation.signal.throwIfAborted()
    const source = SessionIdentity.parse(await context.session.get({ sessionID: invocation.sessionID }))
    if (
      context.location.workspaceID !== undefined ||
      source.location.workspaceID !== undefined ||
      source.projectID !== context.location.project.id ||
      source.location.directory !== context.location.directory
    )
      throw new HandoffError("The sender must be in this host's exact current project and Location")
    switch (input.action) {
      case "list": {
        const request = {
          project: source.projectID,
          parentID: null,
          limit: 20,
          ...(input.query === undefined ? {} : { search: input.query }),
        }
        const page = await context.session.list(request)
        const candidates = page.data
          .map((session) => SessionIdentity.parse(session))
          .filter(
            (session) =>
              session.id !== source.id &&
              session.projectID === source.projectID &&
              session.location.workspaceID === undefined &&
              session.parentID === undefined &&
              session.time.archived === undefined,
          )
          .map((session) => ({
            sessionID: session.id,
            title: session.title,
            agent: session.agent,
            directory: session.location.directory,
            updated: session.time.updated,
          }))
        return {
          content: JSON.stringify({
            candidates,
            more: Boolean(page.cursor.next),
            selection:
              "Choose an exact sessionID. If several sessions fit, ask the user to choose. Refine query to search session titles; no transcripts are searched.",
          }),
        }
      }
      case "send": {
        if (input.sessionID === source.id) throw new HandoffError("Choose another work session")
        const handoff = context.experimental.session.handoff
        if (!handoff) throw new HandoffError("This host does not provide experimental project-bound handoff admission")
        const target = SessionIdentity.parse(await context.session.get({ sessionID: input.sessionID }))
        if (
          target.projectID !== source.projectID ||
          target.location.workspaceID !== undefined ||
          target.parentID !== undefined ||
          target.time.archived !== undefined
        )
          throw new HandoffError("The recipient must be a local, unarchived work session in the exact same project")
        const binding: HandoffBinding = {
          sender: {
            sessionID: invocation.sessionID,
            agent: invocation.agent,
            messageID: invocation.messageID,
            callID: invocation.id,
          },
          target: {
            sessionID: target.id,
            projectID: target.projectID,
            location: target.location,
            ...(target.agent === undefined ? {} : { agent: target.agent }),
          },
          text: input.text,
        }
        const inspected = await handoff({ ...binding, commit: false })
        if (inspected.status !== "approval-required") {
          const receipt = inspected.status === "admitted" ? await handoff({ ...binding, commit: true }) : inspected
          return { content: JSON.stringify(receipt) }
        }
        const question = (await context.tool.list()).find((tool) => tool.id === "question")
        if (!question) throw new HandoffError("The native question tool is required for explicit handoff approval")
        const answer = await question.execute(
          {
            questions: [
              {
                header: "Session handoff",
                question: `Send this exact message to ${target.title ?? target.id} (${target.id}) in ${target.location.directory}? This wakes the target and can incur model/tool costs. If it is busy, the message waits behind active work.\n\nMessage:\n${input.text}`,
                options: [
                  {
                    label: "Send and wake",
                    description: "Approve this recipient and this message once, including paid wake",
                  },
                  { label: "Cancel", description: "Do not send or wake the recipient" },
                ],
              },
            ],
          },
          invocation,
        )
        invocation.signal.throwIfAborted()
        const parsed = Answer.parse(answer.output)
        if (parsed.answers.length !== 1 || parsed.answers[0]?.length !== 1 || parsed.answers[0][0] !== "Send and wake")
          return { content: JSON.stringify({ status: "rejected", admitted: false, wakeScheduled: false }) }
        return { content: JSON.stringify(await handoff({ ...binding, commit: true })) }
      }
      default: {
        const exhaustive: never = input
        return exhaustive
      }
    }
  }
  return context.tool.transform((editor) =>
    editor.add({
      name: "session_handoff",
      options: { codemode: false },
      description:
        "Find an existing work session in this exact project on this host, then ask the user to send it an exact repair/handoff and wake it. Use action=list with a title query first. Return candidate metadata, not transcripts. If multiple sessions fit, ask the user to choose rather than guess. Use action=send with the selected sessionID and full text; the tool asks for approval itself. Approval applies only to this message, includes paid wake, and queues behind busy work without interrupting tools. A delivered receipt means native history promotion, not a completed repair. Never use this for other projects/hosts, grants, or automatic reply loops.",
      input: toPlainJsonSchema(z.toJSONSchema(HandoffInput)),
      execute: async (raw: unknown, invocation) => {
        const key = JSON.stringify([invocation.sessionID, invocation.messageID, invocation.id])
        const binding = JSON.stringify(HandoffInput.parse(raw))
        const current = pending.get(key)
        if (current) {
          if (current.binding !== binding)
            return Promise.reject(new HandoffError("The pending invocation is bound to another target or message"))
          return current.result
        }
        const result = execute(raw, invocation).finally(() => pending.delete(key))
        pending.set(key, { binding, result })
        return result
      },
    }),
  )
}
