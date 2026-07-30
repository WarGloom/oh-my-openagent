import { describe, test, expect } from "bun:test"
import { buildTaskPromptBody } from "./task-prompt-body"
import { OMO_INTERNAL_INITIATOR_MARKER } from "../../../shared/internal-initiator-marker"

describe("buildTaskPromptBody - resume kind", () => {
  test("#given resume with system content #when building prompt body #then system goes to body.system and prompt to parts[0].text", () => {
    //#given
    const options = {
      kind: "resume" as const,
      agent: "explore",
      model: { providerID: "anthropic", modelID: "claude-opus-4-7" },
      prompt: "continue working",
      includeTeamToolDenylist: true,
      system: "<available_skills>\nskill1\nskill2\n</available_skills>",
    }

    //#when
    const body = buildTaskPromptBody(options)

    //#then
    expect(body.system).toBe("<available_skills>\nskill1\nskill2\n</available_skills>")
    expect(body.parts).toHaveLength(1)
    expect(body.parts[0].type).toBe("text")
    expect(body.parts[0].text).toBe(`continue working\n${OMO_INTERNAL_INITIATOR_MARKER}`)
    expect(body.parts[0].synthetic).toBeUndefined()
  })

  test("#given resume without system content #when building prompt body #then body.system is undefined and prompt in parts", () => {
    //#given
    const options = {
      kind: "resume" as const,
      agent: "explore",
      model: { providerID: "anthropic", modelID: "claude-opus-4-7" },
      prompt: "continue working",
      includeTeamToolDenylist: true,
    }

    //#when
    const body = buildTaskPromptBody(options)

    //#then
    expect(body.system).toBeUndefined()
    expect(body.parts).toHaveLength(1)
    expect(body.parts[0].text).toBe(`continue working\n${OMO_INTERNAL_INITIATOR_MARKER}`)
  })

  test("#given launch with system content #when building prompt body #then system goes to body.system", () => {
    //#given
    const options = {
      kind: "launch" as const,
      agent: "explore",
      model: { providerID: "anthropic", modelID: "claude-opus-4-7" },
      prompt: "initial prompt",
      includeTeamToolDenylist: true,
      system: "<available_skills>\nskill1\n</available_skills>",
    }

    //#when
    const body = buildTaskPromptBody(options)

    //#then
    expect(body.system).toBe("<available_skills>\nskill1\n</available_skills>")
    expect(body.parts[0].text).toBe(`initial prompt\n${OMO_INTERNAL_INITIATOR_MARKER}`)
  })

  test("#given canonical reasoning and a stale legacy variant #when building a background prompt #then reasoning wins", () => {
    //#given
    const options = {
      kind: "launch" as const,
      agent: "sisyphus-junior",
      model: {
        providerID: "openai",
        modelID: "gpt-5.6-sol",
        variant: "max",
        reasoning: "high",
        runtimeModel: { variants: { high: {} } },
      },
      prompt: "review the change",
      includeTeamToolDenylist: true,
      system: undefined,
    }

    //#when
    const body = buildTaskPromptBody(options)

    //#then
    expect(body.variant).toBe("high")
  })
})
