import { afterEach, describe, expect, test } from "bun:test"

import { createSystemTransformHandler } from "./system-transform"
import { clearSessionTools, setSessionTools } from "../shared/session-tools-store"

function createHandler(messagesImpl?: () => Promise<unknown>) {
  return createSystemTransformHandler({
    ctx: {
      client: {
        session: {
          messages: messagesImpl ?? (async () => ({ data: [] })),
        },
      },
    } as never,
  })
}

describe("createSystemTransformHandler", () => {
  afterEach(() => {
    clearSessionTools()
  })

  test("appends Serena navigation prompt when session has Serena tools", async () => {
    setSessionTools("ses_serena", {
      serena_find_file: true,
      grep: true,
    })

    const handler = createHandler()
    const output = { system: ["Base system prompt"] }

    await handler(
      {
        sessionID: "ses_serena",
        model: { id: "gpt-5.4", providerID: "openai" },
      },
      output,
    )

    expect(output.system).toHaveLength(2)
    expect(output.system[1]).toContain("<serena_navigation>")
  })

  test("does not append Serena navigation prompt when session lacks Serena tools", async () => {
    setSessionTools("ses_no_serena", {
      grep: true,
      read: true,
    })

    const handler = createHandler()
    const output = { system: ["Base system prompt"] }

    await handler(
      {
        sessionID: "ses_no_serena",
        model: { id: "gpt-5.4", providerID: "openai" },
      },
      output,
    )

    expect(output.system).toEqual(["Base system prompt"])
  })

  test("does not duplicate Serena navigation prompt", async () => {
    setSessionTools("ses_serena", {
      serena_find_file: true,
    })

    const handler = createHandler()
    const output = { system: ["Base system prompt", "<serena_navigation>existing</serena_navigation>"] }

    await handler(
      {
        sessionID: "ses_serena",
        model: { id: "gpt-5.4", providerID: "openai" },
      },
      output,
    )

    expect(output.system).toHaveLength(2)
  })

  test("loads session tools from session messages when cache is empty", async () => {
    const handler = createHandler(async () => ({
      data: [
        {
          info: {
            tools: {
              serena_find_file: true,
              grep: true,
            },
          },
        },
      ],
    }))
    const output = { system: ["Base system prompt"] }

    await handler(
      {
        sessionID: "ses_from_messages",
        model: { id: "gpt-5.4", providerID: "openai" },
      },
      output,
    )

    expect(output.system).toHaveLength(2)
    expect(output.system[1]).toContain("<serena_navigation>")
  })

  test("does not duplicate existing literal ultrawork prompt", async () => {
    const handler = createSystemTransformHandler(
      { ultrawork: true },
      () => "<ultrawork-mode>new</ultrawork-mode>",
    )
    const output = { system: ["Base system prompt", "<ultrawork-mode>existing</ultrawork-mode>"] }

    await handler(
      {
        sessionID: "ses_ultrawork",
        model: { id: "gpt-5.4", providerID: "openai" },
      },
      output,
    )

    expect(output.system).toEqual([
      "Base system prompt",
      "<ultrawork-mode>existing</ultrawork-mode>",
    ])
  })
})
