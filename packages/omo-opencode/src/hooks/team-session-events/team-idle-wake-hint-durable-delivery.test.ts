/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { TeamModeConfigSchema, type TeamModeConfig } from "../../config/schema/team-mode"
import { createTeamMailboxInjector } from "../team-mailbox-injector/hook"
import { buildEnvelope } from "../../features/team-mode/team-mailbox/poll"
import * as reservationModule from "../../features/team-mode/team-mailbox/reservation"
import { sendMessage } from "../../features/team-mode/team-mailbox/send"
import { getInboxDir, resolveBaseDir } from "../../features/team-mode/team-registry/paths"
import { loadRuntimeState, saveRuntimeState } from "../../features/team-mode/team-state-store/store"
import type { Message, RuntimeState } from "../../features/team-mode/types"
import { dispatchInternalPrompt, releaseAllPromptAsyncReservationsForTesting } from "../shared/prompt-async-gate"
import { createTeamIdleWakeHint } from "./team-idle-wake-hint"

type WakePromptInput = {
  path: { id: string }
  body: {
    parts: Array<{ type: "text"; text: string }>
    agent?: string
    model?: { providerID: string; modelID: string }
    variant?: string
  }
  query: { directory: string }
}

type SessionHistoryEntry = { readonly parts: readonly { readonly type: "text"; readonly text: string }[] }
type MailboxSnapshot = { readonly inbox: readonly string[]; readonly processed: readonly string[] }

const temporaryDirectories: string[] = []
const sessionID = "member-session"
const memberName = "worker"
const immediatePromptGateOptions: Parameters<typeof createTeamIdleWakeHint>[2] = {
  idleSettleMs: 0,
  postDispatchHoldMs: 0,
}

function createRuntimeState(teamRunId: string): RuntimeState {
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
        name: memberName,
        sessionId: sessionID,
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

function createMessage(messageId: string, body: string, timestamp: number): Message {
  return {
    version: 1,
    messageId,
    from: "lead",
    to: memberName,
    kind: "message",
    body,
    timestamp,
  }
}

async function createFixture(): Promise<{
  readonly config: TeamModeConfig; readonly teamRunId: string; readonly messages: readonly [Message, Message]
}> {
  const baseDir = await mkdtemp(path.join(tmpdir(), "team-idle-durable-delivery-"))
  temporaryDirectories.push(baseDir)
  const config = TeamModeConfigSchema.parse({ base_dir: baseDir, enabled: true })
  const teamRunId = randomUUID()
  const messages = [
    createMessage(randomUUID(), "first durable payload", 100),
    createMessage(randomUUID(), "second durable payload", 200),
  ] satisfies readonly [Message, Message]
  await mkdir(path.join(baseDir, "runtime", teamRunId), { recursive: true })
  await saveRuntimeState(createRuntimeState(teamRunId), config)
  for (const message of messages) {
    await sendMessage(message, teamRunId, config, { isLead: true, activeMembers: [memberName] })
  }
  return { config, teamRunId, messages }
}

async function readDirectoryIfPresent(directoryPath: string): Promise<string[]> {
  try {
    return await readdir(directoryPath)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    throw error
  }
}

async function snapshotMailbox(config: TeamModeConfig, teamRunId: string): Promise<MailboxSnapshot> {
  const inboxDir = getInboxDir(resolveBaseDir(config), teamRunId, memberName)
  return { inbox: (await readDirectoryIfPresent(inboxDir)).sort(), processed: (await readDirectoryIfPresent(path.join(inboxDir, "processed"))).sort() }
}

async function pendingMessageIds(config: TeamModeConfig, teamRunId: string): Promise<readonly string[]> {
  const runtimeState = await loadRuntimeState(teamRunId, config)
  return runtimeState.members.find((member) => member.name === memberName)?.pendingInjectedMessageIds ?? []
}

async function driveIdle(handler: ReturnType<typeof createTeamIdleWakeHint>): Promise<void> { return handler({ event: { type: "session.idle", properties: { sessionID } } }) }

function historyFromPrompt(input: WakePromptInput): SessionHistoryEntry[] {
  const text = input.body.parts[0]?.text
  if (text === undefined) throw new Error("expected durable wake payload")
  return [{ parts: [{ type: "text", text }] }]
}

afterEach(async () => {
  releaseAllPromptAsyncReservationsForTesting()
  await Promise.all(temporaryDirectories.splice(0).map(async (directoryPath) => {
    await rm(directoryPath, { recursive: true, force: true })
  }))
})

describe("team idle durable mailbox delivery", () => {
  test("#given two transform-only unread messages #when an accepted idle wake dispatches #then it reserves exact envelopes and archives only after history proves both ids", async () => {
    // given
    const { config, teamRunId, messages } = await createFixture()
    let sessionHistory: SessionHistoryEntry[] = []
    let capturedPrompt: WakePromptInput | undefined
    let transformMessageCountDuringWake = -1
    const injector = createTeamMailboxInjector({}, config)
    const transform = injector["experimental.chat.messages.transform"]
    if (transform === undefined) throw new Error("expected team mailbox transform")
    const promptAsync = mock(async (input: WakePromptInput) => {
      capturedPrompt = input
      const output = {
        messages: [{ info: { role: "user", sessionID }, parts: [{ type: "text", text: "durable wake" }] }],
      }
      await transform({ sessionID }, output)
      transformMessageCountDuringWake = output.messages.length
      return {}
    })
    const handler = createTeamIdleWakeHint({
      directory: "/tmp/project",
      client: {
        session: {
          promptAsync,
          messages: async () => ({ data: sessionHistory }),
        },
      },
    }, config, immediatePromptGateOptions)

    // when
    await driveIdle(handler)

    // then
    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(transformMessageCountDuringWake).toBe(1)
    if (capturedPrompt === undefined) throw new Error("expected accepted durable wake prompt")
    const promptText = capturedPrompt.body.parts[0]?.text
    expect(promptText).toContain(buildEnvelope(messages[0]))
    expect(promptText).toContain(buildEnvelope(messages[1]))
    expect(await pendingMessageIds(config, teamRunId)).toEqual(messages.map((message) => message.messageId))
    expect(await snapshotMailbox(config, teamRunId)).toEqual({
      inbox: messages.map((message) => `.delivering-${message.messageId}.json`).sort(), processed: [],
    })

    // when
    sessionHistory = historyFromPrompt(capturedPrompt)
    await driveIdle(handler)

    // then
    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(await pendingMessageIds(config, teamRunId)).toEqual([])
    expect(await snapshotMailbox(config, teamRunId)).toEqual({
      inbox: ["processed"], processed: messages.map((message) => `${message.messageId}.json`).sort(),
    })
  })

  test("#given an ambiguous accepted-like prompt failure #when exact ids later appear in history #then reservations stay pending until the next idle archives them", async () => {
    // given
    const { config, teamRunId, messages } = await createFixture()
    let sessionHistory: SessionHistoryEntry[] = []
    let capturedPrompt: WakePromptInput | undefined
    const promptAsync = mock(async (input: WakePromptInput) => {
      capturedPrompt = input
      throw new Error("JSON Parse error: Unexpected EOF")
    })
    const handler = createTeamIdleWakeHint({
      directory: "/tmp/project",
      client: {
        session: {
          promptAsync,
          messages: async () => ({ data: sessionHistory }),
        },
      },
    }, config, immediatePromptGateOptions)

    // when
    await driveIdle(handler)

    // then
    if (capturedPrompt === undefined) throw new Error("expected ambiguous durable wake prompt")
    expect(await pendingMessageIds(config, teamRunId)).toEqual(messages.map((message) => message.messageId))
    expect(await snapshotMailbox(config, teamRunId)).toEqual({
      inbox: messages.map((message) => `.delivering-${message.messageId}.json`).sort(), processed: [],
    })

    // when
    sessionHistory = historyFromPrompt(capturedPrompt)
    await driveIdle(handler)

    // then
    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(await pendingMessageIds(config, teamRunId)).toEqual([])
    expect(await snapshotMailbox(config, teamRunId)).toEqual({
      inbox: ["processed"], processed: messages.map((message) => `${message.messageId}.json`).sort(),
    })
  })

  test("#given another route owns the prompt gate #when the idle wake is definitely reserved #then it releases every mailbox reservation without recording pending ids", async () => {
    // given
    const { config, teamRunId, messages } = await createFixture()
    const reserveSpy = spyOn(reservationModule, "reserveMessageForDelivery")
    const releaseSpy = spyOn(reservationModule, "releaseDeliveryReservation")
    const promptAsync = mock(async (_input: WakePromptInput) => ({}))
    const blocker = await dispatchInternalPrompt({
      mode: "async",
      client: { session: { promptAsync } },
      sessionID,
      source: "test:durable-mailbox-blocker",
      settleMs: 0,
      postDispatchHoldMs: 30_000,
      input: {
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: "blocker" }] },
        query: { directory: "/tmp/project" },
      },
    })
    expect(blocker.status).toBe("dispatched")
    const handler = createTeamIdleWakeHint({
      directory: "/tmp/project",
      client: { session: { promptAsync } },
    }, config, immediatePromptGateOptions)

    // when
    await driveIdle(handler)

    // then
    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(reserveSpy).toHaveBeenCalledTimes(messages.length)
    expect(releaseSpy).toHaveBeenCalledTimes(messages.length)
    expect(await pendingMessageIds(config, teamRunId)).toEqual([])
    expect(await snapshotMailbox(config, teamRunId)).toEqual({
      inbox: messages.map((message) => `${message.messageId}.json`).sort(), processed: [],
    })
  })

  test("#given a definite non-ambiguous prompt failure #when the idle wake dispatch fails #then it releases every reservation without recording pending ids", async () => {
    // given
    const { config, teamRunId, messages } = await createFixture()
    const reserveSpy = spyOn(reservationModule, "reserveMessageForDelivery")
    const releaseSpy = spyOn(reservationModule, "releaseDeliveryReservation")
    const promptAsync = mock(async (_input: WakePromptInput) => {
      throw new Error("definite prompt rejection")
    })
    const handler = createTeamIdleWakeHint({
      directory: "/tmp/project",
      client: { session: { promptAsync } },
    }, config, immediatePromptGateOptions)

    // when
    await driveIdle(handler)

    // then
    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(reserveSpy).toHaveBeenCalledTimes(messages.length)
    expect(releaseSpy).toHaveBeenCalledTimes(messages.length)
    expect(await pendingMessageIds(config, teamRunId)).toEqual([])
    expect(await snapshotMailbox(config, teamRunId)).toEqual({
      inbox: messages.map((message) => `${message.messageId}.json`).sort(), processed: [],
    })
  })
})
