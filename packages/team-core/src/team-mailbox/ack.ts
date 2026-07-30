import { mkdir, rename } from "node:fs/promises"
import path from "node:path"

import type { TeamModeConfig } from "../config"
import { getInboxDir, resolveBaseDir } from "../team-registry/paths"

export async function ackMessages(
  teamRunId: string,
  memberName: string,
  messageIds: string[],
  config: TeamModeConfig,
): Promise<string[]> {
  const baseDir = resolveBaseDir(config)
  const inboxDir = getInboxDir(baseDir, teamRunId, memberName)
  const processedDir = path.join(inboxDir, "processed")
  await mkdir(processedDir, { recursive: true, mode: 0o700 })
  const ackedMessageIds: string[] = []

  for (const messageId of messageIds) {
    const messageFileName = `${messageId}.json`
    const sourcePaths = [
      path.join(inboxDir, messageFileName),
      path.join(inboxDir, `.delivering-${messageFileName}`),
    ]
    const targetPath = path.join(processedDir, messageFileName)

    for (const sourcePath of sourcePaths) {
      try {
        await rename(sourcePath, targetPath)
        ackedMessageIds.push(messageId)
        break
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          continue
        }

        throw error
      }
    }
  }

  return ackedMessageIds
}
