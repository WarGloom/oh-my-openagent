/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { TeamModeConfigSchema, type TeamModeConfig } from "../../config/schema/team-mode"
import * as reservationModule from "../../features/team-mode/team-mailbox/reservation"
import { sendMessage } from "../../features/team-mode/team-mailbox/send"
import { getInboxDir, resolveBaseDir } from "../../features/team-mode/team-registry/paths"
import * as stateStoreModule from "../../features/team-mode/team-state-store/store"
import type { Message, RuntimeState } from "../../features/team-mode/types"
import * as loggerModule from "../../shared/logger"
import { releaseAllPromptAsyncReservationsForTesting } from "../shared/prompt-async-gate"
import { createTeamIdleWakeHint } from "./team-idle-wake-hint"
import { releaseReservedMailboxBatch, reserveUnreadMailboxBatch } from "./reserved-mailbox-batch"

type WakePromptInput = {
  path: { id: string }
  body: { parts: Array<{ type: "text"; text: string }> }
  query: { directory: string }
}

const temporaryDirectories: string[] = []
const sessionID = "member-session"
const memberName = "worker"

function createRuntimeState(teamRunId: string): RuntimeState {
  return {
    version: 1,
    teamRunId,
    teamName: "team-alpha",
    specSource: "project",
    createdAt: 1,
    status: "active",
    leadSessionId: "lead-session",
    members: [{
      name: memberName,
      sessionId: sessionID,
      agentType: "general-purpose",
      status: "idle",
      pendingInjectedMessageIds: [],
    }],
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

function createMessage(messageId: string, body: string, timestamp: number): Message {
  return { version: 1, messageId, from: "lead", to: memberName, kind: "message", body, timestamp }
}

async function createFixture(): Promise<{
  readonly config: TeamModeConfig; readonly teamRunId: string; readonly messages: readonly [Message, Message]
}> {
  const baseDir = await mkdtemp(path.join(tmpdir(), "team-idle-pending-mark-failure-"))
  temporaryDirectories.push(baseDir)
  const config = TeamModeConfigSchema.parse({ base_dir: baseDir, enabled: true })
  const teamRunId = randomUUID()
  const messages = [
    createMessage(randomUUID(), "first pending mark payload", 100),
    createMessage(randomUUID(), "second pending mark payload", 200),
  ] satisfies readonly [Message, Message]
  await mkdir(path.join(baseDir, "runtime", teamRunId), { recursive: true })
  await stateStoreModule.saveRuntimeState(createRuntimeState(teamRunId), config)
  for (const message of messages) {
    await sendMessage(message, teamRunId, config, { isLead: true, activeMembers: [memberName] })
  }
  return { config, teamRunId, messages }
}

async function mailboxState(config: TeamModeConfig, teamRunId: string): Promise<{
  readonly inbox: readonly string[]; readonly processed: readonly string[]; readonly pending: readonly string[]
}> {
  const inboxDir = getInboxDir(resolveBaseDir(config), teamRunId, memberName)
  let processed: string[] = []
  try {
    processed = await readdir(path.join(inboxDir, "processed"))
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
  }
  const runtimeState = await stateStoreModule.loadRuntimeState(teamRunId, config)
  return {
    inbox: (await readdir(inboxDir)).sort(),
    processed: processed.sort(),
    pending: runtimeState.members.find((member) => member.name === memberName)?.pendingInjectedMessageIds ?? [],
  }
}

afterEach(async () => {
  mock.restore()
  releaseAllPromptAsyncReservationsForTesting()
  await Promise.all(temporaryDirectories.splice(0).map(async (directoryPath) => {
    await rm(directoryPath, { recursive: true, force: true })
  }))
})

describe("team idle pending mailbox batch failure recovery", () => {
  test("#given accepted dispatch but runtime pending persistence throws #when the idle wake handles the failure #then it releases the full batch without acknowledgment", async () => {
    // given
    const { config, teamRunId, messages } = await createFixture()
    const persistenceFailure = new Error("injected pending state persistence failure")
    spyOn(stateStoreModule, "transitionRuntimeState").mockImplementationOnce(async () => { throw persistenceFailure })
    const logSpy = spyOn(loggerModule, "log")
    const promptAsync = mock(async (_input: WakePromptInput) => ({}))
    const handler = createTeamIdleWakeHint({
      directory: "/tmp/project",
      client: { session: { promptAsync } },
    }, config, { idleSettleMs: 0, postDispatchHoldMs: 0 })

    // when
    await handler({ event: { type: "session.idle", properties: { sessionID } } })

    // then
    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(await mailboxState(config, teamRunId)).toEqual({
      inbox: messages.map((message) => `${message.messageId}.json`).sort(), processed: [], pending: [],
    })
    expect(logSpy).toHaveBeenCalledWith("team idle wake pending state failed; released batch", {
      event: "team-mode-idle-wake-hint-pending-state-failed",
      teamRunId,
      memberName,
      sessionID,
      messageIds: messages.map((message) => message.messageId),
      error: persistenceFailure.message,
    })
  })

  test("#given one reservation cannot be released #when batch release runs #then it attempts every reservation and logs the exact failed id", async () => {
    // given
    const { config, teamRunId, messages } = await createFixture()
    const batch = await reserveUnreadMailboxBatch({ teamRunId, memberName, config })
    if (batch === null) throw new Error("expected reserved mailbox batch")
    const originalRelease = reservationModule.releaseDeliveryReservation
    let releaseCount = 0
    const releaseSpy = spyOn(reservationModule, "releaseDeliveryReservation").mockImplementation(async (reservation) => {
      releaseCount += 1
      if (releaseCount === 1) throw new Error("injected reservation release failure")
      await originalRelease(reservation)
    })
    const logSpy = spyOn(loggerModule, "log")

    // when
    await releaseReservedMailboxBatch(batch)

    // then
    expect(releaseSpy).toHaveBeenCalledTimes(messages.length)
    expect(await mailboxState(config, teamRunId)).toEqual({
      inbox: [`.delivering-${messages[0].messageId}.json`, `${messages[1].messageId}.json`].sort(),
      processed: [],
      pending: [],
    })
    expect(logSpy).toHaveBeenCalledWith("team mailbox reservation release failed", {
      event: "team-mode-mailbox-reservation-release-failed",
      teamRunId,
      memberName,
      messageId: messages[0].messageId,
      error: "injected reservation release failure",
    })
  })
})
