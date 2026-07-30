/// <reference types="bun-types" />

// Regression coverage for two durable claim origins. Normal `<id>.json` files are
// transient transform claims that must remain recoverable until a durable wake
// reserves them. Reserved `.delivering-<id>.json` claims require history proof;
// unconfirmed reservations return to the unread inbox or a new durable wake.

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { TeamModeConfigSchema } from "../../config/schema/team-mode"
import type { TeamModeConfig } from "../../config/schema/team-mode"
import * as ackModule from "../../features/team-mode/team-mailbox/ack"
import { sendMessage } from "../../features/team-mode/team-mailbox/send"
import { loadRuntimeState, saveRuntimeState } from "../../features/team-mode/team-state-store/store"
import type { RuntimeState } from "../../features/team-mode/types"
import { getInboxDir, resolveBaseDir } from "../../features/team-mode/team-registry/paths"
import { releaseAllPromptAsyncReservationsForTesting } from "../shared/prompt-async-gate"
import { createTeamIdleWakeHint } from "./team-idle-wake-hint"

const tmpDirs: string[] = []

afterEach(async () => {
  releaseAllPromptAsyncReservationsForTesting()
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function makeBaseDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pending-verify-"))
  tmpDirs.push(dir)
  return dir
}

function makeConfig(baseDir: string): TeamModeConfig {
  return TeamModeConfigSchema.parse({ base_dir: baseDir, enabled: true })
}

function runtimeWithPending(teamRunId: string, messageIds: readonly string[]): RuntimeState {
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
        name: "worker",
        sessionId: "member-session",
        agentType: "general-purpose",
        status: "idle",
        pendingInjectedMessageIds: [...messageIds],
      },
    ],
    shutdownRequests: [],
    bounds: {
      maxMembers: 8,
      maxParallelMembers: 4,
      maxMessagesPerRun: 10000,
      maxWallClockMinutes: 120,
      maxMemberTurns: 500,
    },
  }
}

async function seedPendingReserved(
  teamRunId: string,
  config: TeamModeConfig,
  messageId: string,
  body: string,
): Promise<void> {
  await sendMessage(
    { version: 1, messageId, from: "lead", to: "worker", kind: "message", body, timestamp: 100 },
    teamRunId,
    config,
    { isLead: true, activeMembers: ["worker"], reservedRecipients: new Set(["worker"]) },
  )
}

async function seedPendingSynthetic(
  teamRunId: string,
  config: TeamModeConfig,
  messageId: string,
  body: string,
): Promise<void> {
  await sendMessage(
    { version: 1, messageId, from: "lead", to: "worker", kind: "message", body, timestamp: 100 },
    teamRunId,
    config,
    { isLead: true, activeMembers: ["worker"] },
  )
}

async function readDirectoryIfPresent(directoryPath: string): Promise<string[]> {
  try {
    return await readdir(directoryPath)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return []
    }
    throw error
  }
}

const idleStatus = () => async () => ({ data: { "member-session": { type: "idle" } } })
const noopPromptAsync = async () => ({})

describe("team idle-wake-hint pending live-delivery verification", () => {
  test("#given a transform-only claim with no history proof #when two idle handlers race #then one durable wake is emitted and the racing idle requeues it", async () => {
    // given
    const baseDir = await makeBaseDir()
    const config = makeConfig(baseDir)
    const teamRunId = randomUUID()
    const messageId = randomUUID()
    await mkdir(path.join(baseDir, "runtime", teamRunId), { recursive: true })
    await saveRuntimeState(runtimeWithPending(teamRunId, [messageId]), config)
    await seedPendingSynthetic(teamRunId, config, messageId, "TRANSIENT SYNTHETIC CLAIM")
    const ackSpy = spyOn(ackModule, "ackMessages")
    const durablePayloads: string[] = []
    const promptAsyncSpy = mock(async (input: { body: { parts: Array<{ text: string }> } }) => {
      const payload = input.body.parts[0]?.text
      if (payload === undefined) throw new Error("expected durable wake payload")
      durablePayloads.push(payload)
      return {}
    })
    const handler = createTeamIdleWakeHint({
      directory: "/tmp/project",
      client: {
        session: {
          promptAsync: promptAsyncSpy,
          status: idleStatus(),
          messages: async () => ({ data: [] }),
        },
      },
    }, config, { idleSettleMs: 0 })
    const idleEvent = { event: { type: "session.idle", properties: { sessionID: "member-session" } } }

    // when
    await Promise.all([handler(idleEvent), handler(idleEvent)])

    // then
    expect(ackSpy).not.toHaveBeenCalled()
    expect(promptAsyncSpy).toHaveBeenCalledTimes(1)
    expect(durablePayloads).toHaveLength(1)
    expect(durablePayloads[0]).toContain(`messageId="${messageId}"`)
    expect(durablePayloads[0]).toContain("TRANSIENT SYNTHETIC CLAIM")
    const inboxDir = getInboxDir(resolveBaseDir(config), teamRunId, "worker")
    expect(await readdir(inboxDir)).toEqual([`${messageId}.json`])
    expect(await readDirectoryIfPresent(path.join(inboxDir, "processed"))).toEqual([])
    expect((await loadRuntimeState(teamRunId, config)).members[0]?.pendingInjectedMessageIds).toEqual([])
  })

  test("#given an unconfirmed reserved pending claim absent from session history #when the member settles idle #then it is requeued without loss", async () => {
    // given
    const baseDir = await makeBaseDir()
    const config = makeConfig(baseDir)
    const teamRunId = randomUUID()
    const messageId = randomUUID()
    await mkdir(path.join(baseDir, "runtime", teamRunId), { recursive: true })
    await saveRuntimeState(runtimeWithPending(teamRunId, [messageId]), config)
    await seedPendingReserved(teamRunId, config, messageId, "ROUND 2 CRITIQUE")

    const promptAsyncSpy = mock(noopPromptAsync)
    const handler = createTeamIdleWakeHint(
      {
        directory: "/tmp/project",
        client: {
          session: {
            promptAsync: promptAsyncSpy,
            status: idleStatus(),
            messages: async () => ({ data: [] }), // recipient never saw the message
          },
        },
      },
      config,
      { idleSettleMs: 0 },
    )

    // when
    await handler({ event: { type: "session.idle", properties: { sessionID: "member-session" } } })

    // then
    const inboxDir = getInboxDir(resolveBaseDir(config), teamRunId, "worker")
    const inbox = await readdir(inboxDir)
    const processed = await readDirectoryIfPresent(path.join(inboxDir, "processed"))

    expect(promptAsyncSpy).toHaveBeenCalledTimes(1)
    expect(inbox.includes(`${messageId}.json`)).toBe(false)
    expect(inbox.includes(`.delivering-${messageId}.json`)).toBe(true)
    expect(processed.includes(`${messageId}.json`)).toBe(false)
    expect((await loadRuntimeState(teamRunId, config)).members[0]?.pendingInjectedMessageIds).toEqual([messageId])
  })

  test("#given a confirmed reserved pending claim present in session history #when the member settles idle #then it is archived", async () => {
    // given
    const baseDir = await makeBaseDir()
    const config = makeConfig(baseDir)
    const teamRunId = randomUUID()
    const messageId = randomUUID()
    await mkdir(path.join(baseDir, "runtime", teamRunId), { recursive: true })
    await saveRuntimeState(runtimeWithPending(teamRunId, [messageId]), config)
    await seedPendingReserved(teamRunId, config, messageId, "ROUND 2 CRITIQUE")

    const handler = createTeamIdleWakeHint(
      {
        directory: "/tmp/project",
        client: {
          session: {
            promptAsync: noopPromptAsync,
            status: idleStatus(),
            messages: async () => ({
              data: [
                {
                  role: "user",
                  parts: [
                    {
                      type: "text",
                      text: `<peer_message messageId="${messageId}" from="lead">ROUND 2 CRITIQUE</peer_message>`,
                    },
                  ],
                },
              ],
            }),
          },
        },
      },
      config,
      { idleSettleMs: 0 },
    )

    // when
    await handler({ event: { type: "session.idle", properties: { sessionID: "member-session" } } })

    // then
    const inboxDir = getInboxDir(resolveBaseDir(config), teamRunId, "worker")
    const inbox = await readdir(inboxDir)
    const processed = await readDirectoryIfPresent(path.join(inboxDir, "processed"))

    expect(processed.includes(`${messageId}.json`)).toBe(true)
    expect(inbox.includes(`${messageId}.json`)).toBe(false)
    expect(inbox.includes(`.delivering-${messageId}.json`)).toBe(false)
  })
})
