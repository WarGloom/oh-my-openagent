import type { V2AgentDomain, V2CommandInvocation, V2ModelRef, V2SessionDomain } from "../context-types"
import { renderCommandTemplate } from "./render-command-template"
import { buildCommandPrompt, commandPromptParts } from "./command-prompt"
import type { launchCommandSubtask } from "./command-subtasks"

export type CommandSpec = {
  readonly template: string
  readonly description?: string
  readonly agent?: string
  readonly model?: string
  readonly subtask?: boolean
}

export type CommandPart = { type: string; text?: string; [key: string]: unknown }

/** The plugin's 1.x command hook, translated at native dispatch or after an OMO template renders. */
export type BeforeCommandHook = (
  input: { command: string; sessionID: string; arguments: string; invocationID?: string; agent?: string },
  output: { parts: CommandPart[] },
) => Promise<void>

export type CommandExecutorDeps = {
  readonly name: string
  readonly spec: CommandSpec
  readonly session: V2SessionDomain
  readonly agents: V2AgentDomain
  readonly beforeHook: BeforeCommandHook | undefined
  readonly launchSubtask?: (input: Parameters<typeof launchCommandSubtask>[1]) => Promise<void>
}

function parseModel(model: string | undefined): V2ModelRef | undefined {
  if (model === undefined || !/^[^/#]+\/[^#]+(?:#[^#]+)?$/.test(model)) return undefined
  const separator = model.indexOf("/")
  const rest = model.slice(separator + 1)
  const hash = rest.indexOf("#")
  return {
    providerID: model.slice(0, separator),
    id: hash === -1 ? rest : rest.slice(0, hash),
    ...(hash === -1 ? {} : { variant: rest.slice(hash + 1) }),
  }
}

/**
 * Runs a command on 2.x the way 1.x did: render the template, let the plugin's
 * `command.execute.before` hook rewrite the parts, then send the text as a prompt (after switching
 * agent and model when the command names them: a model named by the command wins, otherwise the
 * named agent's own model, as the 2.x host does for its template commands). If the hook leaves no
 * text, nothing is sent.
 */
export function createCommandExecutor(deps: CommandExecutorDeps): (invocation: V2CommandInvocation) => Promise<void> {
  return async (invocation) => {
    const argumentText = invocation.prompt.text
    const original = {
      ...invocation.prompt,
      text: renderCommandTemplate(deps.spec.template, argumentText),
      metadata: invocation.metadata,
    }
    const parts = commandPromptParts(original)
    await deps.beforeHook?.(
      {
        command: deps.name,
        sessionID: invocation.sessionID,
        arguments: argumentText,
        invocationID: invocation.invocationID,
        agent: invocation.agent,
      },
      { parts },
    )
    const prompt = buildCommandPrompt(original, parts)
    if (!prompt) return
    const agentName = deps.spec.agent
    const agent = (await deps.agents.list()).data.find((entry) => entry.id === (agentName ?? invocation.agent))
    const model = parseModel(deps.spec.model) ?? agent?.model
    if (deps.spec.subtask ?? agent?.mode === "subagent") {
      if (!deps.launchSubtask) throw new Error("Native command subtask launcher is not configured")
      const parent = await deps.session.get({ sessionID: invocation.sessionID })
      const { metadata, ...nativePrompt } = prompt
      await deps.launchSubtask({
        name: deps.name,
        invocation,
        agent: agentName ?? invocation.agent,
        ...((model ?? parent.model) ? { model: model ?? parent.model } : {}),
        description: deps.spec.description ?? deps.name,
        prompt: nativePrompt,
        ...(metadata ? { metadata } : {}),
      })
      return
    }
    if (agentName !== undefined) {
      const current = await deps.session.get({ sessionID: invocation.sessionID })
      if (current.agent !== agentName)
        await deps.session.switchAgent({ sessionID: invocation.sessionID, agent: agentName })
    }
    const inlineModel = parseModel(deps.spec.model) ?? (agentName === undefined ? undefined : agent?.model)
    if (inlineModel !== undefined)
      await deps.session.switchModel({ sessionID: invocation.sessionID, model: inlineModel })
    await deps.session.prompt({
      ...prompt,
      sessionID: invocation.sessionID,
      delivery: invocation.delivery,
    })
  }
}
