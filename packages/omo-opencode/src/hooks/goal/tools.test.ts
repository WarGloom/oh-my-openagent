/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import type { GoalController } from "./controller"
import { createGoalTools } from "./tools"
import type { Goal } from "./types"

function makeContext(sessionID = "s1"): ToolContext {
  return {
    sessionID,
    messageID: "m1",
    agent: "test",
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

function makeGoal(overrides?: Partial<Goal>): Goal {
  const now = Date.now()
  return {
    id: "g1",
    sessionID: "s1",
    objective: "Ship",
    status: "active",
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function makeDeps(controller: Partial<GoalController> = {}, sessionID?: string) {
  return {
    controller: {
      setGoal: () => makeGoal(),
      getGoal: () => null,
      pauseGoal: () => null,
      resumeGoal: () => null,
      clearGoal: () => false,
      markComplete: () => null,
      accountUsage: () => null,
      updateTui: () => {},
      ...controller,
    } as GoalController,
    getSessionID: () => sessionID,
  }
}

describe("createGoalTools", () => {
  for (const globalSessionID of [undefined, "wrong-session"]) {
    for (const explicitSessionID of [undefined, "explicit-session"]) {
      test(`all goal tools bind invocation with global=${globalSessionID}, explicit=${explicitSessionID}`, async () => {
        // given
        const calls: [string, string][] = []
        const controller = {
          setGoal: (sessionID: string, objective: string) => {
            calls.push(["set", sessionID])
            return makeGoal({ sessionID, objective })
          },
          getGoal: (sessionID: string) => {
            calls.push(["get", sessionID])
            return makeGoal({ sessionID })
          },
          markComplete: (sessionID: string) => {
            calls.push(["complete", sessionID])
            return makeGoal({ sessionID, status: "complete" })
          },
        }
        const tools = createGoalTools(makeDeps(controller, globalSessionID))
        // when
        for (const invocation of ["invocation-one", "invocation-two"]) {
          const context = makeContext(invocation)
          const args = { session_id: explicitSessionID }
          await tools.create_goal.execute({ ...args, objective: "Ship" }, context)
          await tools.get_goal.execute(args, context)
          await tools.update_goal.execute({ ...args, objective: "Updated", status: "complete" }, context)
        }
        // then
        expect(calls).toEqual(
          ["invocation-one", "invocation-two"].flatMap((invocation) => {
            const target = explicitSessionID ?? invocation
            return [
              ["set", target],
              ["get", target],
              ["set", target],
              ["complete", target],
              ["get", target],
            ]
          }),
        )
      })
    }
  }
  test("create_goal calls controller.setGoal with current session", async () => {
    const setGoal = (sessionID: string, objective: string) => makeGoal({ sessionID, objective })
    const deps = makeDeps({ setGoal }, "s1")
    const tools = createGoalTools(deps)

    const result = await tools.create_goal.execute({ objective: "Ship" }, makeContext())

    expect(result).toContain("Ship")
    expect(result).toContain('"status": "active"')
  })

  test("create_goal uses explicit session_id", async () => {
    const calls: [string, string][] = []
    const setGoal = (sessionID: string, objective: string) => {
      calls.push([sessionID, objective])
      return makeGoal()
    }
    const deps = makeDeps({ setGoal }, undefined)
    const tools = createGoalTools(deps)

    await tools.create_goal.execute({ objective: "Ship", session_id: "s2" }, makeContext())

    expect(calls).toEqual([["s2", "Ship"]])
  })

  test("update_goal completes goal", async () => {
    const markCalls: string[] = []
    const markComplete = (sessionID: string) => {
      markCalls.push(sessionID)
      return makeGoal({ status: "complete" })
    }
    const getGoal = () => makeGoal({ status: "complete" })
    const deps = makeDeps({ markComplete, getGoal }, "s1")
    const tools = createGoalTools(deps)

    const result = await tools.update_goal.execute({ status: "complete" }, makeContext())

    expect(markCalls).toEqual(["s1"])
    expect(result).toContain('"status": "complete"')
  })

  test("update_goal changes objective", async () => {
    const setCalls: [string, string][] = []
    const setGoal = (sessionID: string, objective: string) => {
      setCalls.push([sessionID, objective])
      return makeGoal({ objective })
    }
    const getGoal = () => makeGoal({ objective: "New" })
    const deps = makeDeps({ setGoal, getGoal }, "s1")
    const tools = createGoalTools(deps)

    const result = await tools.update_goal.execute({ objective: "New" }, makeContext())

    expect(setCalls).toEqual([["s1", "New"]])
    expect(result).toContain("New")
  })

  test("get_goal returns current goal", async () => {
    const getCalls: string[] = []
    const getGoal = (sessionID: string) => {
      getCalls.push(sessionID)
      return makeGoal({ objective: "Read" })
    }
    const deps = makeDeps({ getGoal }, "s1")
    const tools = createGoalTools(deps)

    const result = await tools.get_goal.execute({}, makeContext())

    expect(getCalls).toEqual(["s1"])
    expect(result).toContain("Read")
  })

  test("get_goal returns null when absent", async () => {
    const deps = makeDeps({ getGoal: () => null }, "s1")
    const tools = createGoalTools(deps)

    const result = await tools.get_goal.execute({}, makeContext())

    expect(result).toContain('"goal": null')
  })
})
