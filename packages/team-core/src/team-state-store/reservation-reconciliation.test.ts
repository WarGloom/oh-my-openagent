/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { TeamModeConfigSchema } from "../config"
import type { TeamModeConfig } from "../config"
import type { TeamSessionContext } from "../session-client"
import { getInboxDir, resolveBaseDir } from "../team-registry/paths"
import type { RuntimeState } from "../types"
import { reconcileStaleReservationsForMember } from "./reservation-reconciliation"
import { loadRuntimeState, saveRuntimeState } from "./store"

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
        status: "running",
        lastInjectedTurnMarker: "member-session#1",
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

async function createFixture(fileState: "reserved" | "inbox" = "reserved"): Promise<{
  readonly config: TeamModeConfig
  readonly ctx: TeamSessionContext
  readonly runtimeState: RuntimeState
  readonly messageId: string
  readonly inboxDir: string
}> {
  const baseDir = await mkdtemp(path.join(tmpdir(), "reservation-reconciliation-ordering-"))
  temporaryDirectories.push(baseDir)
  const config = TeamModeConfigSchema.parse({
    base_dir: baseDir,
    enabled: true,
  })
  const teamRunId = randomUUID()
  const messageId = randomUUID()
  const runtimeState = createRuntimeState(teamRunId, messageId)
  await mkdir(path.join(baseDir, "runtime", teamRunId), { recursive: true })
  await saveRuntimeState(runtimeState, config)
  const inboxDir = getInboxDir(resolveBaseDir(config), teamRunId, "worker")
  await mkdir(inboxDir, { recursive: true })
  const messagePath = path.join(inboxDir, fileState === "reserved" ? `.delivering-${messageId}.json` : `${messageId}.json`)
  await writeFile(
    messagePath,
    JSON.stringify({
      version: 1,
      messageId,
      from: "lead",
      to: "worker",
      kind: "message",
      body: "stale pending reservation",
      timestamp: 1,
    }),
  )
  if (fileState === "reserved") {
    const staleMtime = new Date(Date.now() - 60_000)
    await utimes(messagePath, staleMtime, staleMtime)
  }
  const ctx: TeamSessionContext = {
    client: {
      session: {
        get: async () => ({ data: { id: "member-session" } }),
        messages: async () => ({ data: [] }),
      },
    },
  }
  return { config, ctx, runtimeState, messageId, inboxDir }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directoryPath) => {
      await rm(directoryPath, { recursive: true, force: true })
    }),
  )
})

describe("resume stale reservation state-before-files reconciliation", () => {
  test("#given pending-state persistence fails #when stale reservation reconciliation runs #then the reservation stays hidden while the ID remains pending", async () => {
    // given
    const { config, ctx, runtimeState, messageId, inboxDir } = await createFixture()
    const member = runtimeState.members[0]
    if (member === undefined) throw new Error("worker fixture missing")
    const persistenceFailure = new Error("injected resume persistence failure")

    // when
    const reconciliation = reconcileStaleReservationsForMember(ctx, runtimeState.teamRunId, member, config, 0, {
      transitionRuntimeState: async () => {
        throw persistenceFailure
      },
    })

    // then
    let observedFailure: unknown
    try {
      await reconciliation
    } catch (error) {
      if (!(error instanceof Error)) throw error
      observedFailure = error
    }
    expect(observedFailure).toBe(persistenceFailure)
    const entries = await readdir(inboxDir)
    expect(entries).toContain(`.delivering-${messageId}.json`)
    expect(entries).not.toContain(`${messageId}.json`)
    const worker = (await loadRuntimeState(runtimeState.teamRunId, config)).members[0]
    expect(worker?.pendingInjectedMessageIds).toEqual([messageId])
  })

  test("#given a pending ID backed by a normal inbox file #when resume reconciliation runs #then state clears while the file remains unread", async () => {
    // given
    const { config, ctx, runtimeState, messageId, inboxDir } = await createFixture("inbox")
    const member = runtimeState.members[0]
    if (member === undefined) throw new Error("worker fixture missing")

    // when
    await reconcileStaleReservationsForMember(ctx, runtimeState.teamRunId, member, config, 0)

    // then
    const worker = (await loadRuntimeState(runtimeState.teamRunId, config)).members[0]
    expect(worker?.pendingInjectedMessageIds).toEqual([])
    expect(worker?.lastInjectedTurnMarker).toBeUndefined()
    const entries = await readdir(inboxDir)
    expect(entries).toContain(`${messageId}.json`)
    expect(entries).not.toContain(`.delivering-${messageId}.json`)
  })
})
