import { afterEach, expect, test } from "bun:test"
import { createTeamToolGating } from "./hook"
import { createRemovalTestContext } from "../../features/team-mode/team-runtime/remove-member.test-support"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { registerTeamSession } from "../../features/team-mode/team-session-registry"

const { fixture, cleanup } = createRemovalTestContext()
afterEach(cleanup)

test.each(["worker-session", "outside-session"])("removal gating rejects trusted non-lead %s", async (sessionID) => {
  // given
  const input = await fixture()
  const directory = input.config.base_dir ?? ""
  const ctx = {
    client: createOpencodeClient(),
    project: { id: "test", worktree: directory, time: { created: 1, updated: 1 } },
    directory,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://127.0.0.1:1"),
    $: Bun.$,
  }
  const hook = createTeamToolGating(ctx, input.config)
  // when / then
  await expect(
    hook["tool.execute.before"]?.(
      { tool: "team_remove_member", sessionID, callID: "remove" },
      { args: { teamRunId: input.teamRunId, memberName: "worker", role: "lead" } },
    ),
  ).rejects.toThrow("team_remove_member is lead-only")
})

test("removal gating admits the trusted lead of the target run", async () => {
  // given
  const input = await fixture()
  const directory = input.config.base_dir ?? ""
  const ctx = {
    client: createOpencodeClient(),
    project: { id: "test", worktree: directory, time: { created: 1, updated: 1 } },
    directory,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://127.0.0.1:1"),
    $: Bun.$,
  }
  const hook = createTeamToolGating(ctx, input.config)
  // when / then
  await expect(
    hook["tool.execute.before"]?.(
      { tool: "team_remove_member", sessionID: "lead-session", callID: "remove" },
      { args: { teamRunId: input.teamRunId, memberName: "worker" } },
    ),
  ).resolves.toBeUndefined()
})

test("removal gating rejects a stale registry lead role", async () => {
  // given
  const input = await fixture()
  const directory = input.config.base_dir ?? ""
  const ctx = {
    client: createOpencodeClient(),
    project: { id: "test", worktree: directory, time: { created: 1, updated: 1 } },
    directory,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://127.0.0.1:1"),
    $: Bun.$,
  }
  registerTeamSession("worker-session", { teamRunId: input.teamRunId, memberName: "worker", role: "lead" })
  const hook = createTeamToolGating(ctx, input.config)
  // when / then
  await expect(
    hook["tool.execute.before"]?.(
      { tool: "team_remove_member", sessionID: "worker-session", callID: "remove" },
      { args: { teamRunId: input.teamRunId, memberName: "worker" } },
    ),
  ).rejects.toThrow("team_remove_member is lead-only")
})
