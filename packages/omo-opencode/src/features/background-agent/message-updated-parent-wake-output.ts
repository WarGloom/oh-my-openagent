import { isEmptyNoProgressAssistantTurnInfo } from "./empty-assistant-turn"

function isTerminalAssistantFinish(finish: unknown): boolean {
  return finish === true || finish === "stop" || finish === "error" || finish === "end_turn"
}

export function messageUpdatedInfoEndsParentWakeActivity(info: Record<string, unknown>, role: unknown): boolean {
  if (role !== "assistant") {
    return false
  }
  return info.error !== undefined || isTerminalAssistantFinish(info.finish)
}

export function messageUpdatedInfoHasParentWakeActivity(info: Record<string, unknown>, role: unknown): boolean {
  if (role === "tool") {
    return true
  }
  if (role !== "assistant") {
    return false
  }
  if (info.error || isEmptyNoProgressAssistantTurnInfo(info)) {
    return false
  }
  return !isTerminalAssistantFinish(info.finish)
}

export function messageUpdatedInfoHasParentWakeOutput(info: Record<string, unknown>, role: unknown): boolean {
  if (role === "tool") {
    return true
  }
  if (role !== "assistant") {
    return false
  }
  if (info.error) {
    return false
  }
  return !isEmptyNoProgressAssistantTurnInfo(info)
}
