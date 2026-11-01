import { expect, onTestFinished, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { TeamModeConfigSchema } from "../config"
import { createRuntimeState, loadRuntimeState, transitionRuntimeState } from "../team-state-store/store"
import { getRuntimeStateDir, resolveBaseDir } from "../team-registry/paths"
import type { TeamSpec } from "../types"
import { sendMessage } from "./send"
import { inspectDeliveryReservationState } from "./reservation"
import { deliverMailboxV2 } from "./v2-delivery"

async function setup() {
  const baseDir = path.join(tmpdir(), `team-v2-delivery-${randomUUID()}`)
  onTestFinished(() => rmSync(baseDir, { recursive: true, force: true }))
  const config = TeamModeConfigSchema.parse({ base_dir: baseDir })
  const spec = {
    version: 1,
    name: "team",
    createdAt: 1,
    leadAgentId: "m1",
    members: [
      {
        kind: "subagent_type",
        name: "m1",
        backendType: "in-process",
        subagent_type: "general-purpose",
        isActive: true,
      },
    ],
  } satisfies TeamSpec
  const state = await createRuntimeState(spec, "lead-session", "project", config)
  const teamRunId = state.teamRunId
  await transitionRuntimeState(
    teamRunId,
    (current) => ({
      ...current,
      members: current.members.map((member) => (member.name === "m1" ? { ...member, sessionId: "session-A" } : member)),
    }),
    config,
  )
  const messageId = randomUUID()
  await sendMessage(
    { version: 1, messageId, from: "lead", to: "m1", kind: "message", body: "hello", timestamp: 1 },
    teamRunId,
    config,
    { isLead: true, activeMembers: ["m1"] },
  )
  return { config, teamRunId, memberName: "m1", sessionID: "session-A", messageId }
}

test("#given failed admission #when delivery retries #then the message remains pending until admitted", async () => {
  // given
  const input = await setup()
  const error = new Error("offline")
  // when
  await expect(
    deliverMailboxV2({
      ...input,
      admit: async () => {
        throw error
      },
    }),
  ).rejects.toBe(error)
  const before = await loadRuntimeState(input.teamRunId, input.config)
  const delivered = await deliverMailboxV2({ ...input, admit: async () => {} })
  // then
  expect(before.members[0]?.pendingInjectedMessageIds).toEqual([])
  expect(delivered).toEqual([input.messageId])
  expect(await inspectDeliveryReservationState(input.teamRunId, input.memberName, input.messageId, input.config)).toBe(
    "reserved",
  )
})

test("#given a crash after admission #when delivery retries #then the same synthetic ID is reused", async () => {
  // given
  const input = await setup()
  const accepted = new Set<string>()
  let first = true
  const admit = async ({ id }: { readonly id: string }) => {
    accepted.add(id)
    if (first) {
      first = false
      throw new Error("crash after admission")
    }
  }
  // when
  await expect(deliverMailboxV2({ ...input, admit })).rejects.toThrow("crash after admission")
  const delivered = await deliverMailboxV2({ ...input, admit })
  // then
  expect(accepted.size).toBe(1)
  expect(delivered).toEqual([input.messageId])
})

test("#given a session replaced before delivery #when admission runs #then it targets the replacement", async () => {
  // given
  const input = await setup()
  await transitionRuntimeState(
    input.teamRunId,
    (state) => ({
      ...state,
      members: state.members.map((member) => (member.name === "m1" ? { ...member, sessionId: "session-B" } : member)),
    }),
    input.config,
  )
  const admitted: string[] = []
  // when
  const stale = await deliverMailboxV2({
    ...input,
    admit: async ({ sessionID }) => {
      admitted.push(sessionID)
    },
  })
  const delivered = await deliverMailboxV2({
    ...input,
    sessionID: "session-B",
    admit: async ({ sessionID }) => {
      admitted.push(sessionID)
    },
  })
  // then
  expect(stale).toEqual([])
  expect(delivered).toEqual([input.messageId])
  expect(admitted).toEqual(["session-B"])
})

test("#given admission holds the state lock #when a replacement runs concurrently #then it follows the delivery", async () => {
  // given
  const input = await setup()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const order: string[] = []
  // when
  const delivery = deliverMailboxV2({
    ...input,
    admit: async ({ sessionID }) => {
      order.push(`admit:${sessionID}`)
      started.resolve()
      await release.promise
      order.push("admitted")
    },
  })
  await started.promise
  expect(
    (await stat(path.join(getRuntimeStateDir(resolveBaseDir(input.config), input.teamRunId), "state.lock"))).isFile(),
  ).toBe(true)
  const replacement = transitionRuntimeState(
    input.teamRunId,
    (state) => {
      order.push("replacement")
      return {
        ...state,
        members: state.members.map((member) => (member.name === "m1" ? { ...member, sessionId: "session-B" } : member)),
      }
    },
    input.config,
  )
  release.resolve()
  const [delivered] = await Promise.all([delivery, replacement])
  // then
  expect(delivered).toEqual([input.messageId])
  expect(order).toEqual(["admit:session-A", "admitted", "replacement"])
})
