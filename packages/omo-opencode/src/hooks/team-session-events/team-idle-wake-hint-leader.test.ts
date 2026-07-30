/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { TeamModeConfigSchema } from "../../config/schema/team-mode"
import type { TeamModeConfig } from "../../config/schema/team-mode"
import { sendMessage } from "../../features/team-mode/team-mailbox/send"
import { getInboxDir, resolveBaseDir } from "../../features/team-mode/team-registry/paths"
import { saveRuntimeState } from "../../features/team-mode/team-state-store/store"
import type { RuntimeState } from "../../features/team-mode/types"
import {
  releaseAllPromptAsyncReservationsForTesting,
  releasePromptAsyncReservation,
} from "../shared/prompt-async-gate"
import { createTeamIdleWakeHint } from "./team-idle-wake-hint"

type WakeHintPromptInput = {
  readonly path: { readonly id: string }
  readonly body: {
    readonly parts: readonly { readonly type: "text"; readonly text: string }[]
  }
  readonly query: { readonly directory: string }
}

const temporaryDirectories: string[] = []
const COMPLETION_CYCLE_COUNT = 6
const immediatePromptGateOptions: Parameters<typeof createTeamIdleWakeHint>[2] = {
  idleSettleMs: 0,
  postDispatchHoldMs: 0,
}

async function createTemporaryBaseDir(): Promise<string> {
  const baseDir = await mkdtemp(path.join(tmpdir(), "team-leader-wake-hint-"))
  temporaryDirectories.push(baseDir)
  return baseDir
}

function createConfig(baseDir: string): TeamModeConfig {
  return TeamModeConfigSchema.parse({ base_dir: baseDir, enabled: true })
}

function createLeaderRuntimeState(teamRunId: string): RuntimeState {
  return {
    version: 1,
    teamRunId,
    teamName: "team-alpha",
    specSource: "project",
    createdAt: 1,
    status: "active",
    leadSessionId: "lead-session",
    members: [
      {
        name: "lead",
        sessionId: "lead-session",
        agentType: "leader",
        status: "idle",
        pendingInjectedMessageIds: [],
      },
      {
        name: "worker",
        sessionId: "worker-session",
        agentType: "general-purpose",
        status: "idle",
        pendingInjectedMessageIds: [],
      },
    ],
    shutdownRequests: [],
    bounds: {
      maxMembers: 8,
      maxParallelMembers: 4,
      maxMessagesPerRun: 10_000,
      maxWallClockMinutes: 120,
      maxMemberTurns: 500,
    },
  }
}

async function seedRuntimeState(runtimeState: RuntimeState, config: TeamModeConfig): Promise<void> {
  await mkdir(path.join(config.base_dir ?? "", "runtime", runtimeState.teamRunId), { recursive: true })
  await saveRuntimeState(runtimeState, config)
}

async function sendCompletionToLead(teamRunId: string, config: TeamModeConfig, body: string, timestamp: number): Promise<string> {
  const messageId = randomUUID()
  await sendMessage({
    version: 1,
    messageId,
    from: "worker",
    to: "lead",
    kind: "message",
    body,
    timestamp,
  }, teamRunId, config, { isLead: false, activeMembers: ["lead"] })
  return messageId
}

afterEach(async () => {
  releaseAllPromptAsyncReservationsForTesting()
  await Promise.all(temporaryDirectories.splice(0).map(async (directoryPath) => {
    await rm(directoryPath, { recursive: true, force: true })
  }))
})

describe("createTeamIdleWakeHint leader delivery", () => {
  test("#given repeated member completions to an idle leader #when each cycle idles after delivery #then every completion wakes the leader", async () => {
    // given
    const baseDir = await createTemporaryBaseDir()
    const config = createConfig(baseDir)
    const teamRunId = randomUUID()
    await seedRuntimeState(createLeaderRuntimeState(teamRunId), config)

    const promptInputs: WakeHintPromptInput[] = []
    const promptAsyncSpy = mock(async (input: WakeHintPromptInput) => {
      promptInputs.push(input)
      return {}
    })
    const handler = createTeamIdleWakeHint({
      directory: "/tmp/project",
      client: {
        session: {
          promptAsync: promptAsyncSpy,
          messages: async () => ({ data: promptInputs }),
        },
      },
    }, config, immediatePromptGateOptions)

    // when
    const completionBodies = Array.from(
      { length: COMPLETION_CYCLE_COUNT },
      (_, index) => `completion ${index + 1}`,
    )
    const completionMessageIds: string[] = []
    for (const [index, body] of completionBodies.entries()) {
      completionMessageIds.push(await sendCompletionToLead(teamRunId, config, body, 100 + index))
      await handler({ event: { type: "session.idle", properties: { sessionID: "lead-session" } } })
      releasePromptAsyncReservation("lead-session", "team-idle-wake-hint")
    }
    await handler({ event: { type: "session.idle", properties: { sessionID: "lead-session" } } })

    // then
    expect(promptAsyncSpy).toHaveBeenCalledTimes(COMPLETION_CYCLE_COUNT)
    expect(promptInputs.map((input) => input.path.id)).toEqual(Array(COMPLETION_CYCLE_COUNT).fill("lead-session"))
    for (const [index, body] of completionBodies.entries()) {
      expect(promptInputs[index]?.body.parts[0]?.text).toContain(body)
    }

    const inboxDir = getInboxDir(resolveBaseDir(config), teamRunId, "lead")
    expect(await readdir(inboxDir)).toEqual(["processed"])
    expect((await readdir(path.join(inboxDir, "processed"))).sort()).toEqual(
      completionMessageIds.map((messageId) => `${messageId}.json`).sort(),
    )
  }, 30_000)
})
