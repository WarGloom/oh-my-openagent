import { describe, expect, it } from "bun:test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { applyDesiredCommands } from "./apply-commands"
import type { CommandSpec } from "./create-command-executor"
import type { DesiredConfig } from "./desired-config"

const spec: CommandSpec = { template: "do it" }

function desired(commands: ReadonlyArray<readonly [string, CommandSpec]>): DesiredConfig {
  return unsafeTestValue({ commands })
}

describe("applyDesiredCommands", () => {
  it("#given a /goal command among the desired commands #when applied #then goal is skipped so the host goal stays reachable", () => {
    // given
    const added: string[] = []
    const editor = { add: (definition: { name: string }) => void added.push(definition.name) }

    // when
    applyDesiredCommands(
      editor as never,
      desired([["goal", spec], ["refactor", spec]]),
      unsafeTestValue({ session: {}, agents: {}, beforeHook: undefined }),
    )

    // then
    expect(added).toEqual(["refactor"])
  })
})
