/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { TeamModeConfigSchema } from "../../config/schema/team-mode"
import type { TeamModeConfig } from "../../config/schema/team-mode"
import { sendMessage } from "../../features/team-mode/team-mailbox/send"
import { getInboxDir, resolveBaseDir } from "../../features/team-mode/team-registry/paths"
import {
  loadRuntimeState,
  saveRuntimeState,
  transitionRuntimeState,
} from "../../features/team-mode/team-state-store/store"
import type { RuntimeState } from "../../features/team-mode/types"
import { settleIdleClaims, settleTerminalErrorClaims } from "./pending-claim-settlement"

const temporaryDirectories: string[] = []

function createRuntimeState(teamRunId: string, messageId: string): RuntimeState {
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
        lastInjectedTurnMarker: "turn:pending",
        pendingInjectedMessageIds: [messageId],
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

async function createFixture(reserved: boolean): Promise<{
  readonly config: TeamModeConfig
  readonly teamRunId: string
  readonly messageId: string
}> {
  const baseDir = await mkdtemp(path.join(tmpdir(), "pending-claim-ordering-"))
  temporaryDirectories.push(baseDir)
  const config = TeamModeConfigSchema.parse({
    base_dir: baseDir,
    enabled: true,
  })
  const teamRunId = randomUUID()
  const messageId = randomUUID()
  await mkdir(path.join(baseDir, "runtime", teamRunId), { recursive: true })
  await saveRuntimeState(createRuntimeState(teamRunId, messageId), config)
  await sendMessage(
    {
      version: 1,
      messageId,
      from: "lead",
      to: "worker",
      kind: "message",
      body: "ordering-sensitive claim",
      timestamp: 1,
    },
    teamRunId,
    config,
    {
      isLead: true,
      activeMembers: ["worker"],
      ...(reserved ? { reservedRecipients: new Set(["worker"]) } : {}),
    },
  )
  return { config, teamRunId, messageId }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directoryPath) => {
      await rm(directoryPath, { recursive: true, force: true })
    }),
  )
})

describe("pending claim state-before-files settlement", () => {
  test("#given runtime persistence fails for a synthetic claim #when idle settlement runs #then no mailbox file is archived or requeued", async () => {
    // given
    const { config, teamRunId, messageId } = await createFixture(false)
    const persistenceFailure = new Error("injected runtime persistence failure")

    // when
    const settlement = settleIdleClaims(
      {
        teamRunId,
        memberName: "worker",
        sessionID: "member-session",
        config,
        client: { session: { messages: async () => ({ data: [] }) } },
      },
      {
        transitionRuntimeState: async () => {
          throw persistenceFailure
        },
      },
    )

    // then
    let observedFailure: unknown
    try {
      await settlement
    } catch (error) {
      if (!(error instanceof Error)) throw error
      observedFailure = error
    }
    expect(observedFailure).toBe(persistenceFailure)
    const inboxDir = getInboxDir(resolveBaseDir(config), teamRunId, "worker")
    const entries = await readdir(inboxDir)
    expect(entries).toContain(`${messageId}.json`)
    expect(entries).not.toContain("processed")
    expect((await loadRuntimeState(teamRunId, config)).members[0]?.pendingInjectedMessageIds).toEqual([messageId])
  })

  test("#given the member session is replaced during idle settlement #when the exact-session transition runs #then it returns stale without changing the reservation", async () => {
    // given
    const { config, teamRunId, messageId } = await createFixture(true)

    // when
    const settlement = await settleIdleClaims(
      {
        teamRunId,
        memberName: "worker",
        sessionID: "member-session",
        config,
        client: { session: { messages: async () => ({ data: [] }) } },
      },
      {
        transitionRuntimeState: async (runId, transition, runtimeConfig) =>
          transitionRuntimeState(
            runId,
            (runtimeState) => transition({
              ...runtimeState,
              members: runtimeState.members.map((member) =>
                member.name === "worker" ? { ...member, sessionId: "replacement-session" } : member,
              ),
            }),
            runtimeConfig,
          ),
      },
    )

    // then
    expect(settlement.kind).toBe("stale-session")
    const entries = await readdir(getInboxDir(resolveBaseDir(config), teamRunId, "worker"))
    expect(entries).toContain(`.delivering-${messageId}.json`)
    expect(entries).not.toContain(`${messageId}.json`)
    expect((await loadRuntimeState(teamRunId, config)).members[0]?.pendingInjectedMessageIds).toEqual([messageId])
  })

  test("#given the member session is replaced after reserved-claim classification #when terminal settlement commits #then it returns stale without releasing the reservation", async () => {
    // given
    const { config, teamRunId, messageId } = await createFixture(true)

    // when
    const settlement = await settleTerminalErrorClaims(
      {
        teamRunId,
        memberName: "worker",
        sessionID: "member-session",
        config,
        client: { session: { messages: async () => ({ data: [] }) } },
      },
      {
        transitionRuntimeState: async (runId, transition, runtimeConfig) =>
          transitionRuntimeState(
            runId,
            (runtimeState) =>
              transition({
                ...runtimeState,
                members: runtimeState.members.map((member) =>
                  member.name === "worker"
                  ? {
                      ...member,
                      sessionId: "replacement-session",
                      status: "running",
                    }
                    : member,
                ),
              }),
            runtimeConfig,
          ),
      },
    )

    // then
    expect(settlement.kind).toBe("stale-session")
    const inboxDir = getInboxDir(resolveBaseDir(config), teamRunId, "worker")
    const entries = await readdir(inboxDir)
    expect(entries).toContain(`.delivering-${messageId}.json`)
    expect(entries).not.toContain(`${messageId}.json`)
    const worker = (await loadRuntimeState(teamRunId, config)).members[0]
    expect(worker?.sessionId).toBe("replacement-session")
    expect(worker?.pendingInjectedMessageIds).toEqual([messageId])
  })
})
