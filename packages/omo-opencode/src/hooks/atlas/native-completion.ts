import type { PluginInput } from "@opencode-ai/plugin"
import { getWorkForSession, readBoulderState } from "../../features/boulder-state"
import { collectGitDiffStats, formatFileChanges } from "../../shared/git-worktree"
import { handleSubagentCompletionAfter } from "./tool-execute-after-subagent-completion"
import type { PendingTaskRef, SessionState } from "./types"

export type NativeAtlasCompletion = {
  readonly sessionID: string
  readonly childSessionID: string
  readonly agent: string
  readonly state: "completed" | "error" | "cancelled"
  readonly text: string
}

export async function handleNativeCompletion(input: {
  readonly ctx: PluginInput
  readonly completion: NativeAtlasCompletion
  readonly autoCommit: boolean
  readonly getState: (sessionID: string) => SessionState
}): Promise<string | undefined> {
  const { ctx, completion } = input
  const boulder = readBoulderState(ctx.directory)
  const work = getWorkForSession(ctx.directory, completion.sessionID)
  const task = Object.values(work?.task_sessions ?? boulder?.task_sessions ?? {}).find(
    (entry) =>
      entry.session_id === completion.childSessionID || entry.session_id === `opencode:${completion.childSessionID}`,
  )
  if (boulder && !task) return
  const pendingTaskRef: PendingTaskRef | undefined = task
    ? {
        kind: "track",
        task: { key: task.task_key, label: task.task_label, title: task.task_title },
      }
    : undefined
  const output = {
    title: "Native subagent completion",
    output: completion.text,
    metadata: { sessionId: completion.childSessionID, agent: completion.agent },
  }
  await handleSubagentCompletionAfter({
    ctx,
    pendingTaskRefs: new Map(),
    autoCommit: input.autoCommit,
    getState: input.getState,
    collectGitDiffStats,
    formatFileChanges,
    toolInput: { tool: "task", sessionID: completion.sessionID },
    toolOutput: output,
    metadataSessionId: completion.childSessionID,
    nativeCompletion: { pendingTaskRef, succeeded: completion.state === "completed" },
  })
  return output.output === completion.text ? undefined : output.output
}
