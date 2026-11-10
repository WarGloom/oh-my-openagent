import { afterEach, describe, expect, test } from "bun:test"
import { cleanupNativeFixtures, fixture } from "../../v2/native-subagent-jobs-test-fixture"
import { formatFullSession } from "../../tools/background-task/full-session-format"
import { formatTaskResult } from "../../tools/background-task/task-result-format"
import type { BackgroundOutputClient } from "../../tools/background-task/clients"

afterEach(cleanupNativeFixtures)

const DENIAL_LINE = 'Launch blocked: skill "codebase-memory" was denied. Model execution did not start.'

function blockedSkillAcceptance(): Error {
  return Object.assign(new Error("Permission denied: skill"), {
    _tag: "Permission.BlockedError",
    permission: "skill",
    resources: ["codebase-memory"],
    rules: [{ action: "skill", resource: "*", effect: "deny" }],
  })
}

function emptyMessagesClient(): BackgroundOutputClient {
  const client: BackgroundOutputClient = {
    session: {
      messages: async () => ({ data: [] }),
    },
  }
  return client
}

describe("BackgroundManager native launch denial", () => {
  test("#given a skill acceptance blocked before model execution #when the launch is processed #then the manager stores a safe pre-model diagnosis, ends terminal, and does not retry or dispatch a model", async () => {
    // given
    const f = await fixture({
      activate: async () => {
        throw blockedSkillAcceptance()
      },
      cleanupDelay: 60_000,
    })

    // when
    const launched = await f.manager.launch({ ...f.launch("denied-skill"), skills: ["codebase-memory"] })
    await f.manager.waitForNativeTask(launched.id, new AbortController().signal)
    const task = f.manager.getTask(launched.id)
    if (!task) throw new Error("denied task was removed before assertion")

    // then — real denial shape caught and stored as an allowlisted, provably pre-model diagnosis
    expect(task.launchDenial).toEqual({
      kind: "permission-denied",
      permission: "skill",
      resources: ["codebase-memory"],
      phase: "before-model-execution",
    })

    // then — terminal, with no provider/model dispatch and no retry/replacement attempt
    expect(task.status).toBe("error")
    expect(f.starts).toEqual([])
    expect(f.prompts).toEqual([])
    expect(task.attempts?.length).toBe(1)
    expect(task.attempts?.[0]?.status).toBe("error")

    // then — both background_output forms surface the same safe line
    const full = await formatFullSession(task, emptyMessagesClient(), {
      includeThinking: false,
      includeToolResults: false,
    })
    const result = await formatTaskResult(task, emptyMessagesClient())
    expect(full).toContain(DENIAL_LINE)
    expect(result).toContain(DENIAL_LINE)
  })

  test("#given a skill denial after native dispatch #when processed #then the stored diagnosis must not claim model execution never started", async () => {
    // given
    const f = await fixture({ cleanupDelay: 60_000 })
    const start = f.domain.start
    f.domain.start = async (input) => {
      await start(input)
      throw blockedSkillAcceptance()
    }

    // when
    const launched = await f.manager.launch({ ...f.launch("denied-tool"), skills: ["codebase-memory"] })
    await f.manager.waitForNativeTask(launched.id, new AbortController().signal)
    const task = f.manager.getTask(launched.id)
    if (!task) throw new Error("denied task was removed before assertion")

    // then — a permission-shaped error without a proven pre-model phase does not assert no-execution
    expect(task.launchDenial?.phase).toBeUndefined()
    expect(f.starts).toHaveLength(1)
    const result = await formatTaskResult(task, emptyMessagesClient())
    expect(result).not.toContain("Model execution did not start")
  })
})
