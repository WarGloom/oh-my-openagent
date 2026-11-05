import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { NativeIdleArbiter, type NativeIdleEvent } from "./native-idle-arbiter"
import { bindNativeIdleArbiter } from "./native-idle-arbiter"
import { createFakePluginContext } from "./fake-plugin-context"
import { createPluginInput } from "./create-plugin-input"
import { createSessionTracker } from "./session-tracker"
import { _resetForTesting, registerAgentName } from "../features/claude-code-session-state"
import { injectBoulderContinuation } from "../hooks/atlas/boulder-continuation-injector"

function fixture() {
  let recovery = false
  let pending = false
  const restore = Promise.withResolvers<void>()
  const fake = createFakePluginContext({
    sessionMessages: [
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "atlas",
        model: { providerID: "mock", id: "local" },
        content: [],
        time: { created: 1 },
      },
    ],
  })
  const arbiter = new NativeIdleArbiter(fake.context, {
    isNativeRecoveryPending: () => recovery,
    settleCompactionRestore: () => restore.promise,
    hasPendingWork: () => pending,
  })
  const idle = async (background: NativeIdleEvent["background"] = []) => {
    await fake.triggerIdle({ sessionID: "parent", background })
  }
  return {
    fake,
    arbiter,
    idle,
    restore: restore.resolve,
    get rows() {
      return fake.sessionCalls.flatMap((call) => (call.kind === "synthetic" ? [call.input.text] : []))
    },
    invalidate: () => fake.context.session.prompt({ sessionID: "parent", text: "new input", resume: false }),
    recovery: () => {
      recovery = true
    },
    pending: () => {
      pending = true
    },
  }
}

afterEach(() => {
  _resetForTesting()
})

describe("native idle continuation admission", () => {
  it("admits a delayed Atlas continuation through the real facade after the synchronous idle closure expires", async () => {
    const fake = createFakePluginContext({
      sessionAgent: "atlas",
      sessionMessages: [
        {
          id: "msg_assistant",
          type: "assistant",
          agent: "atlas",
          model: { providerID: "mock", id: "local" },
          content: [],
          time: { created: 1 },
        },
      ],
    })
    const input = createPluginInput(fake.context, { tracker: createSessionTracker(), warn: () => {} })
    const arbiter = new NativeIdleArbiter(fake.context, {
      isNativeRecoveryPending: () => false,
      settleCompactionRestore: async () => {},
      hasPendingWork: () => false,
    })
    bindNativeIdleArbiter(input, arbiter)
    registerAgentName("atlas")
    await arbiter.start()
    try {
      await fake.triggerIdle({ sessionID: "parent", background: [] })
      // when
      const result = await injectBoulderContinuation({
        ctx: input,
        sessionID: "parent",
        planName: "plan",
        remaining: 1,
        total: 1,
        agent: "atlas",
        sessionState: { promptFailureCount: 0 },
      })
      // then
      expect(result).toBe("injected")
      expect(fake.sessionCalls.filter((call) => call.kind === "synthetic")).toHaveLength(1)
      expect(fake.sessionCalls.filter((call) => call.kind === "prompt")).toEqual([])
    } finally {
      await arbiter.dispose()
    }
  })

  it("submits through the settled succeeded boundary only after restoration settles", async () => {
    const f = fixture()
    await f.arbiter.start()
    await f.idle()
    const continuation = f.arbiter.admit("parent", "continue", "todo")
    expect(f.rows).toEqual([])
    f.restore()
    expect((await continuation).status).toBe("dispatched")
    expect(f.rows).toEqual(["continue"])
    await f.arbiter.dispose()
  })

  it("keeps a late durable input rejection from becoming a continuation", async () => {
    const f = fixture()
    await f.arbiter.start()
    await f.idle()
    const continuation = f.arbiter.admit("parent", "continue", "todo")
    await f.invalidate()
    f.restore()
    expect((await continuation).status).toBe("cancelled")
    expect(f.rows).toEqual([])
    await f.arbiter.dispose()
  })

  it("lets the host arbitrate competing sources instead of two synthetic writes", async () => {
    const f = fixture()
    await f.arbiter.start()
    await f.idle()
    f.restore()
    await Promise.all([f.arbiter.admit("parent", "todo", "todo"), f.arbiter.admit("parent", "atlas", "atlas")])
    expect(f.rows).toEqual(["todo"])
    await f.arbiter.dispose()
  })

  it.each([true, false])("honors native parent wake disposition %s", async (wakes) => {
    const f = fixture()
    await f.arbiter.start()
    await f.idle([
      { kind: "subagent", sessionID: "parent", childSessionID: "child", agent: "worker", description: "work", wakes },
    ])
    f.restore()
    const result = await f.arbiter.admit("parent", "continue", "todo")
    expect(result.status).toBe(wakes ? "active" : "dispatched")
    expect(f.rows).toEqual(wakes ? [] : ["continue"])
    await f.arbiter.dispose()
  })

  it.each(["recovery", "pending"] as const)("refuses continuation while %s work owns the session", async (reason) => {
    const f = fixture()
    await f.arbiter.start()
    await f.idle()
    f.restore()
    f[reason]()
    expect((await f.arbiter.admit("parent", "continue", "atlas")).status).toBe("active")
    expect(f.rows).toEqual([])
    await f.arbiter.dispose()
  })

  it("uses the synchronous closure before the host settles the execution", async () => {
    const f = fixture()
    await f.arbiter.start()
    f.restore()
    const accepted = Promise.withResolvers<string>()
    f.arbiter.onIdle(async () => {
      accepted.resolve((await f.arbiter.admit("parent", "sync", "atlas")).status)
    })
    try {
      await f.idle()
      expect(await accepted.promise).toBe("dispatched")
      expect(f.rows).toEqual(["sync"])
      expect(f.fake.sessionHistory("parent").some((entry) => entry.type === "idle")).toBe(false)
    } finally {
      await f.arbiter.dispose()
    }
  })

  it("rejects delayed admission after interruption without a synthetic fallback", async () => {
    const f = fixture()
    await f.arbiter.start()
    await f.idle()
    f.restore()
    try {
      await f.fake.context.session.interrupt({ sessionID: "parent" })
      expect((await f.arbiter.admit("parent", "continue", "atlas")).status).toBe("cancelled")
      expect(f.rows).toEqual([])
    } finally {
      await f.arbiter.dispose()
    }
  })

  it("keeps resume:false input pending through the actual client facade", async () => {
    const f = fixture()
    const input = createPluginInput(f.fake.context, { tracker: createSessionTracker(), warn: () => {} })
    await f.arbiter.start()
    await f.idle()
    f.restore()
    try {
      await input.client.session.promptAsync({
        path: { id: "parent" },
        body: { noReply: true, parts: [{ type: "text", text: "new user input" }] },
      })
      expect((await f.arbiter.admit("parent", "continue", "atlas")).status).toBe("cancelled")
      expect(f.rows).toEqual([])
    } finally {
      await f.arbiter.dispose()
    }
  })

  it("propagates the host prepared-child rejection after the original idle hook", async () => {
    const f = fixture()
    await f.arbiter.start()
    await f.idle()
    f.restore()
    using children = spyOn(f.fake.context.experimental.subagent, "reconcile").mockResolvedValue([
      { admissionID: "prepared", parentSessionID: "parent", childSessionID: "child", status: "prepared" },
    ])
    try {
      expect((await f.arbiter.admit("parent", "continue", "atlas")).status).toBe("cancelled")
      expect(f.rows).toEqual([])
    } finally {
      await f.arbiter.dispose()
    }
  })

  it("preserves duplicate outcomes without another admission", async () => {
    const f = fixture()
    await f.arbiter.start()
    await f.idle()
    f.restore()
    try {
      expect(await f.arbiter.admit("parent", "first", "atlas")).toMatchObject({
        status: "dispatched",
        response: "admitted",
      })
      expect(await f.arbiter.admit("parent", "changed duplicate", "atlas")).toMatchObject({
        status: "dispatched",
        response: "duplicate",
      })
      expect(f.rows).toEqual(["first"])
    } finally {
      await f.arbiter.dispose()
    }
  })

  it("does not adopt a later succeeded execution beyond the captured boundary", async () => {
    const f = fixture()
    await f.arbiter.start()
    await f.idle()
    f.restore()
    f.fake
      .sessionHistory("parent")
      .push(
        { id: "later_user", type: "user", text: "new task", time: { created: 3 } },
        { id: "later_success", type: "idle", outcome: "succeeded", time: { created: 4 } },
      )
    try {
      expect((await f.arbiter.admit("parent", "old continuation", "atlas")).status).toBe("cancelled")
      expect(f.rows).toEqual([])
    } finally {
      await f.arbiter.dispose()
    }
  })
})
