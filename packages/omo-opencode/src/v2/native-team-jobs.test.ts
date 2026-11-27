import { expect, test } from "bun:test"
import { mock } from "node:test"
import type { V2SyntheticInput } from "./context-types"
import { createFakePluginContext } from "./fake-plugin-context"
import { admitNativeTeamMessage } from "./native-team-jobs"

test.each([false, true])("#given a deferred lead queue already delivered: %s #then expiry only wakes pending input", async (delivered) => {
  // given
  const fake = createFakePluginContext()
  const calls: V2SyntheticInput[] = []
  const pending = new Set<string>()
  const consumed = new Set<string>()
  const wakes: string[][] = []
  const context = {
    ...fake.context,
    session: {
      ...fake.context.session,
      synthetic: async (input: V2SyntheticInput) => {
        calls.push(input)
        if (!input.id || consumed.has(input.id)) return
        pending.add(input.id)
        if (input.resume !== false) wakes.push([...pending])
      },
    },
  }
  const identity = { teamRunId: "team", memberName: "lead" }
  const first = { sessionID: "lead-session", id: "msg_first", text: "first", wakeAfterMs: 100 }
  const second = { ...first, id: "msg_second", text: "second" }
  mock.timers.enable({ apis: ["setTimeout"] })
  try {
    await admitNativeTeamMessage(context, first, identity)
    mock.timers.tick(50)
    await admitNativeTeamMessage(context, second, identity)
    if (delivered) {
      for (const id of pending) consumed.add(id)
      pending.clear()
    }

    // when
    mock.timers.tick(49)
    expect(calls.map(({ resume }) => resume)).toEqual([false, false])
    mock.timers.tick(1)
    mock.timers.tick(1_000)

    // then
    expect(calls.map(({ id, delivery, resume }) => ({ id, delivery, resume }))).toEqual([
      { id: first.id, delivery: "steer", resume: false },
      { id: second.id, delivery: "steer", resume: false },
      { id: second.id, delivery: "steer", resume: true },
    ])
    expect(wakes).toEqual(delivered ? [] : [[first.id, second.id]])
  } finally {
    mock.timers.reset()
  }
})
