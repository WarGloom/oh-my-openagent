import type { V2CommandBeforeEvent, V2CommandDomain, V2Registration } from "../context-types"
import { AUTO_SLASH_COMMAND_TAG_OPEN } from "../../hooks/auto-slash-command/constants"
import type { BeforeCommandHook } from "./create-command-executor"
import { buildCommandPrompt, commandPromptParts } from "./command-prompt"

export function registerNativeCommandBefore(
  commands: V2CommandDomain,
  before: BeforeCommandHook,
  owns: (name: string) => boolean,
): Promise<V2Registration> {
  return commands.hook("experimental.command.before", async (event: V2CommandBeforeEvent & { expanded?: boolean }) => {
    if (event.disposition !== "continue" || owns(event.name)) return
    const original = { ...event.prompt, metadata: event.metadata }
    const parts = commandPromptParts(original)
    const originalText = new Map(parts.filter((part) => part.type === "text").map((part) => [part, part.text]))
    await before({
      command: event.name, sessionID: event.sessionID, arguments: event.prompt.text,
      invocationID: event.invocationID, agent: event.agent,
    }, { parts })
    const expanded = parts.some((part) => part.type === "text" && part.text?.includes(AUTO_SLASH_COMMAND_TAG_OPEN))
    const prompt = buildCommandPrompt(original, expanded
      ? parts.filter((part) => !originalText.has(part) || originalText.get(part) !== part.text || part.text?.includes(AUTO_SLASH_COMMAND_TAG_OPEN))
      : parts)
    if (!prompt) {
      event.disposition = "cancelled"
      return
    }
    const { metadata, ...nativePrompt } = prompt
    event.prompt = nativePrompt
    event.metadata = metadata ? { ...metadata } : undefined
    if (expanded) event.expanded = true
  })
}
