import { expect, test } from "bun:test"
import { createFakePluginContext } from "./fake-plugin-context"
import { registerSessionHandoff } from "./session-handoff"
import type { HandoffBinding, NativeHandoffReceipt } from "./session-handoff-types"
import type { V2PluginContext, V2ToolExecuteContext } from "./context-types"

const invocation: V2ToolExecuteContext = {
  sessionID: "ses_sender",
  agent: "sisyphus",
  messageID: "msg_send",
  id: "call_send",
  signal: new AbortController().signal,
  progress: async () => {},
}
const request = { action: "send", sessionID: "ses_target", text: "Repair the missing failure response" }

async function fixture(answer: readonly string[] = ["Send and wake"]) {
  const fake = createFakePluginContext({ sessionAgent: "sisyphus" })
  const questions: unknown[] = []
  const admitted: HandoffBinding[] = []
  let approved: HandoffBinding | undefined
  let onQuestion: (() => void) | undefined
  const context: V2PluginContext = {
    ...fake.context,
    session: {
      ...fake.context.session,
      get: async (input) => ({ ...(await fake.context.session.get(input)), title: `Work ${input.sessionID}` }),
      list: async () => ({
        data: await Promise.all(
          ["ses_sender", "ses_target", "ses_other"].map(async (sessionID) => ({
            ...(await fake.context.session.get({ sessionID })),
            ...(sessionID === "ses_other" ? { projectID: "other" } : {}),
          })),
        ),
        cursor: {},
      }),
    },
    experimental: {
      ...fake.context.experimental,
      session: {
        ...fake.context.experimental.session,
        handoff: async (input): Promise<NativeHandoffReceipt> => {
          if (!input.commit)
            return {
              id: "msg_durable",
              sessionID: input.target.sessionID,
              status: approved ? "delivered" : "approval-required",
              duplicate: approved !== undefined,
              wakeScheduled: false,
            }
          admitted.push(input)
          approved = input
          return {
            id: "msg_durable",
            sessionID: input.target.sessionID,
            status: "admitted",
            duplicate: false,
            wakeScheduled: true,
          }
        },
      },
    },
  }
  await context.tool.transform((editor) =>
    editor.add({
      name: "question",
      description: "Native question boundary fixture",
      input: {},
      execute: async (input: unknown) => {
        questions.push(input)
        onQuestion?.()
        return { output: { answers: [answer] } }
      },
    }),
  )
  const registration = await registerSessionHandoff(context)
  const tool = (await context.tool.list()).find((entry) => entry.id === "session_handoff")
  if (!tool) throw new Error("Missing registered handoff tool")
  return {
    fake,
    context,
    questions,
    admitted,
    registration,
    onQuestion: (callback: () => void) => {
      onQuestion = callback
    },
    execute: (input: unknown = request, caller: V2ToolExecuteContext = invocation) => tool.execute(input, caller),
  }
}

test("asks the user with the exact recipient, content and wake before native admission despite permission allow", async () => {
  const f = await fixture()
  const result = await f.execute()
  expect(f.questions).toHaveLength(1)
  expect(JSON.stringify(f.questions[0])).toContain(request.text)
  expect(JSON.stringify(f.questions[0])).toContain(request.sessionID)
  expect(f.admitted).toHaveLength(1)
  expect(f.admitted[0]).toMatchObject({
    text: request.text,
    target: { sessionID: request.sessionID, projectID: "proj_1" },
    sender: {
      sessionID: invocation.sessionID,
      agent: invocation.agent,
      messageID: invocation.messageID,
      callID: invocation.id,
    },
  })
  expect(JSON.parse(String(result.content))).toMatchObject({ status: "admitted", wakeScheduled: true })
})

test.each([{ answer: ["Cancel"] }, { answer: [] }, { answer: ["Send and wake", "Cancel"] }, { answer: ["yes"] }])(
  "admits nothing for a non-approval answer $answer",
  async ({ answer }) => {
    const f = await fixture(answer)
    expect(JSON.parse(String((await f.execute()).content))).toMatchObject({
      status: "rejected",
      admitted: false,
      wakeScheduled: false,
    })
    expect(f.admitted).toEqual([])
  },
)

test("keeps the approved content immutable when the caller input changes while the question is open", async () => {
  const f = await fixture()
  const mutable = { ...request }
  f.onQuestion(() => {
    mutable.text = "Replacement"
    mutable.sessionID = "ses_replacement"
  })
  await f.execute(mutable)
  expect(f.admitted[0]).toMatchObject({ text: request.text, target: { sessionID: request.sessionID } })
})

test("propagates a dismissed native question without admitting or waking", async () => {
  const f = await fixture()
  f.onQuestion(() => {
    throw new Error("User dismissed the native question")
  })
  await expect(f.execute()).rejects.toThrow("dismissed")
  expect(f.admitted).toEqual([])
})

test("joins duplicate in-flight invocations and uses the native receipt instead of asking again after admission", async () => {
  const f = await fixture()
  await Promise.all([f.execute(), f.execute()])
  const retry = await f.execute()
  expect(f.questions).toHaveLength(1)
  expect(f.admitted).toHaveLength(1)
  expect(JSON.parse(String(retry.content))).toMatchObject({
    status: "delivered",
    duplicate: true,
    wakeScheduled: false,
  })
})

test("rejects a substituted target or message under an active invocation", async () => {
  const f = await fixture()
  const first = f.execute()
  await expect(f.execute({ ...request, text: "Another message" })).rejects.toThrow("bound to another target or message")
  await first
  expect(f.admitted).toHaveLength(1)
})

test("discovers only other work sessions in the exact project using session metadata", async () => {
  const f = await fixture()
  const result = JSON.parse(String((await f.execute({ action: "list" })).content))
  expect(result.candidates.map((entry: { sessionID: string }) => entry.sessionID)).toEqual(["ses_target"])
  expect(f.questions).toEqual([])
  expect(f.admitted).toEqual([])
})

test.each([
  { ...request, sessionID: "ses_sender" },
  { ...request, sessionID: "https://other-host/ses_target" },
  { ...request, host: "other-host" },
])("rejects self or foreign host addressing before approval", async (input) => {
  const f = await fixture()
  await expect(f.execute(input)).rejects.toThrow()
  expect(f.questions).toEqual([])
  expect(f.admitted).toEqual([])
})
