import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadTeamSpec } from "@oh-my-opencode/team-core/team-registry/loader"
import { JevRoutingConfigSchema } from "../../../config/schema/jev-routing"
import { createTeamCreateTool } from "./lifecycle-create-tool"
import {
  backgroundManager,
  config,
  createTeamRunMock,
  createToolContext,
  listActiveTeamsMock,
  loadRuntimeStateMock,
  mockClient,
  resetLifecycleTestState,
} from "./lifecycle-test-fixture"

describe("named team category defaults", () => {
  let root = ""
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  test.each([
    [{ mode: "active", default: "quick" }, true],
    [{ mode: "active", agent_ladders: { helper: { ladder: ["a", "b"], default: "a" } } }, false],
    [{ mode: "off", default: "quick" }, false],
  ])("loads omitted category only with eligible routing (%s)", async (rawRouting, eligible) => {
    resetLifecycleTestState()
    root = await mkdtemp(join(tmpdir(), "named-auto-"))
    const specDir = join(root, "teams", "alpha")
    await mkdir(specDir, { recursive: true })
    await writeFile(
      join(specDir, "config.json"),
      JSON.stringify({
        name: "alpha",
        leadAgentId: "lead",
        members: [
          { name: "lead", kind: "subagent_type", subagent_type: "sisyphus" },
          { name: "worker", kind: "category", prompt: "Inspect the implementation" },
        ],
      }),
    )
    const tool = createTeamCreateTool(
      { ...config, base_dir: root },
      mockClient,
      backgroundManager,
      undefined,
      { jevRouting: JevRoutingConfigSchema.parse(rawRouting), userCategories: { writing: {} } },
      {
        createTeamRun: createTeamRunMock,
        loadTeamSpec,
        listActiveTeams: listActiveTeamsMock,
        loadRuntimeState: loadRuntimeStateMock,
      },
    )
    const execution = tool.execute({ teamName: "alpha" }, createToolContext("lead-session"))
    if (eligible) {
      await execution
      expect(createTeamRunMock.mock.calls[0]?.[0].members).toContainEqual(
        expect.objectContaining({ name: "worker", category: "auto" }),
      )
    } else {
      await expect(execution).rejects.toThrow()
      expect(createTeamRunMock).not.toHaveBeenCalled()
    }
  })
})
