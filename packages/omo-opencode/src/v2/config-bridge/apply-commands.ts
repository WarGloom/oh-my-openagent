import type { V2AgentDomain, V2CommandDefinition, V2SessionDomain } from "../context-types"
import { createCommandExecutor, type BeforeCommandHook } from "./create-command-executor"
import type { DesiredConfig } from "./desired-config"

export type ApplyCommandsDeps = {
  readonly session: V2SessionDomain
  readonly agents: V2AgentDomain
  readonly beforeHook: BeforeCommandHook | undefined
  readonly launchSubtask?: Parameters<typeof createCommandExecutor>[0]["launchSubtask"]
}

/** Applies the desired commands inside a 2.x command transform. */
export function applyDesiredCommands(
  editor: { readonly add: (definition: V2CommandDefinition) => void },
  desired: DesiredConfig,
  deps: ApplyCommandsDeps,
): void {
  for (const [name, spec] of desired.commands) {
    // The host owns /goal on 2.x; skip OMO's so the native goal command stays reachable.
    if (name === "goal") continue
    editor.add({
      name,
      ...(spec.description === undefined ? {} : { description: spec.description }),
      execute: createCommandExecutor({ name, spec, session: deps.session, agents: deps.agents, beforeHook: deps.beforeHook, launchSubtask: deps.launchSubtask }),
    })
  }
}
