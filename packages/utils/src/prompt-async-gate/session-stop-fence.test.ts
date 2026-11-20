import { afterEach, expect, test } from "bun:test"
import {
  dispatchInternalPrompt,
  fenceInternalPrompts,
  releaseAllPromptAsyncReservationsForTesting,
} from "../prompt-async-gate"
import { withDispatchTimeout } from "./timing"

afterEach(() => releaseAllPromptAsyncReservationsForTesting())

test("fence drains an admitted request even after its dispatch timeout", async () => {
  // given
  const released = Promise.withResolvers<void>()
  const events: string[] = []
  const client = {
    session: {
      promptAsync: async (input: { text: string }) => {
        events.push(input.text)
        if (input.text === "first") {
          await released.promise
          events.push("first-settled")
        }
      },
    },
  }
  const args = {
    mode: "async" as const,
    client,
    sessionID: "stop-drain",
    source: "test",
    settleMs: 0,
    queue: false,
    checkStatus: false,
    checkToolState: false,
  }
  const first = await dispatchInternalPrompt({ ...args, input: { text: "first" }, dispatchTimeoutMs: 1 })
  expect(first.status).toBe("failed")
  // when
  const drained = fenceInternalPrompts(args.sessionID).then(() => {
    events.push("abort")
    return undefined
  })
  const second = await dispatchInternalPrompt({ ...args, source: "second", input: { text: "second" } })
  released.resolve()
  await withDispatchTimeout(drained, 1000, "test dispatch drain")
  // then
  expect(second.status).not.toBe("dispatched")
  expect(events).toEqual(["first", "first-settled", "abort"])
})

test("final admission rejects a predicate which resolves after fencing", async () => {
  // given
  const entered = Promise.withResolvers<void>()
  const decision = Promise.withResolvers<boolean>()
  let sends = 0
  const dispatching = dispatchInternalPrompt({
    mode: "async",
    sessionID: "stop-predicate",
    source: "test",
    input: {},
    settleMs: 0,
    client: {
      session: {
        promptAsync: async () => {
          sends += 1
        },
      },
    },
    shouldDispatch: () => {
      entered.resolve()
      return decision.promise
    },
  })
  await withDispatchTimeout(entered.promise, 1000, "test predicate entered")
  // when
  await fenceInternalPrompts("stop-predicate")
  decision.resolve(true)
  const result = await withDispatchTimeout(dispatching, 1000, "test predicate completion")
  // then
  expect(result.status).toBe("cancelled")
  expect(sends).toBe(0)
})

test("fencing an admitted request prevents a legacy path replay", async () => {
  const firstSend = Promise.withResolvers<void>()
  const firstResponse = Promise.withResolvers<void>()
  const paths: Array<string | { id: string }> = []
  const sessionID = "stop-path-replay"
  const dispatching = dispatchInternalPrompt({
    mode: "async",
    sessionID,
    source: "test",
    input: { path: { id: sessionID } },
    settleMs: 0,
    client: {
      session: {
        promptAsync: async (input: { path: string | { id: string } }) => {
          paths.push(input.path)
          if (typeof input.path === "string") return
          firstSend.resolve()
          await firstResponse.promise
          throw new TypeError('The "path" property must be of type string; got object')
        },
      },
    },
  })
  await withDispatchTimeout(firstSend.promise, 1000, "test first send")

  const drained = fenceInternalPrompts(sessionID)
  firstResponse.resolve()
  await withDispatchTimeout(Promise.all([drained, dispatching]), 1000, "test fenced replay")

  expect(paths).toEqual([{ id: sessionID }])
})
