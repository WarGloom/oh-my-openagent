import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { TeamModeConfigSchema } from "../../../config/schema/team-mode"
import type { TeamModeConfig } from "../../../config/schema/team-mode"
import { sendMessage } from "../team-mailbox/send"
import { getInboxDir, getRuntimeStateDir, resolveBaseDir } from "../team-registry/paths"
import { saveRuntimeState, transitionRuntimeState } from "../team-state-store/store"
import { MessageSchema, type RuntimeState, type TeamSpec } from "../types"
import { bindNativeTeamWorktrees, createNativeTeamWorktrees } from "../../../v2/native-team-worktrees"

let fixtureCounter = 0

function createUuid(sequence: number): string {
  return `123e4567-e89b-42d3-a456-${sequence.toString(16).padStart(12, "0")}`
}

export function createConfig(baseDir: string): TeamModeConfig {
  return TeamModeConfigSchema.parse({ base_dir: baseDir })
}

export function createSpec(worktreeRoot: string): TeamSpec {
  fixtureCounter += 1

  return {
    version: 1,
    name: `team-${fixtureCounter.toString(16).padStart(8, "0")}`,
    createdAt: Date.now(),
    leadAgentId: "lead",
    members: [
      { kind: "subagent_type", name: "lead", subagent_type: "sisyphus", backendType: "in-process", isActive: true },
      {
        kind: "category",
        name: "member-a",
        category: "deep",
        prompt: "work on task a",
        backendType: "in-process",
        isActive: true,
        worktreePath: path.join(worktreeRoot, "member-a"),
      },
      {
        kind: "category",
        name: "member-b",
        category: "deep",
        prompt: "work on task b",
        backendType: "in-process",
        isActive: true,
        worktreePath: path.join(worktreeRoot, "member-b"),
      },
    ],
  }
}

export async function createFixture(options?: { status?: RuntimeState["status"] }): Promise<{
  baseDir: string
  config: TeamModeConfig
  teamRunId: string
  worktreePaths: string[]
}> {
  fixtureCounter += 1
  const baseDir = await mkdtemp(path.join(tmpdir(), `team-runtime-shutdown-${fixtureCounter}-`))
  const config = createConfig(baseDir)
  const worktreeRoot = path.join(baseDir, "fixture-worktrees")
  const teamRunId = createUuid(fixtureCounter)
  const runtimeState: RuntimeState = {
    version: 1,
    teamRunId,
    teamName: createSpec(worktreeRoot).name,
    specSource: "project",
    createdAt: Date.now(),
    status: options?.status ?? "active",
    leadSessionId: "lead-session",
    members: [
      { name: "lead", agentType: "leader", status: "pending", pendingInjectedMessageIds: [] },
      {
        name: "member-a",
        agentType: "general-purpose",
        status: "pending",
        pendingInjectedMessageIds: [],
        worktreePath: path.join(worktreeRoot, "member-a"),
      },
      {
        name: "member-b",
        agentType: "general-purpose",
        status: "pending",
        pendingInjectedMessageIds: [],
        worktreePath: path.join(worktreeRoot, "member-b"),
      },
    ],
    shutdownRequests: [],
    bounds: {
      maxMembers: config.max_members,
      maxParallelMembers: config.max_parallel_members,
      maxMessagesPerRun: config.max_messages_per_run,
      maxWallClockMinutes: config.max_wall_clock_minutes,
      maxMemberTurns: config.max_member_turns,
    },
  }
  await mkdir(getRuntimeStateDir(resolveBaseDir(config), teamRunId), { recursive: true })
  await saveRuntimeState(runtimeState, config)

  return {
    baseDir,
    config,
    teamRunId: runtimeState.teamRunId,
    worktreePaths: [path.join(worktreeRoot, "member-a"), path.join(worktreeRoot, "member-b")],
  }
}

export async function createNativeFixture() {
  const fixture = await createFixture()
  const directory = path.join(fixture.baseDir, "lead")
  const git = async (cwd: string, ...args: string[]) => {
    const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) throw new Error(stderr)
    return stdout.trim()
  }
  await mkdir(directory)
  await git(directory, "init", "--quiet", "--initial-branch=lead")
  await writeFile(path.join(directory, "fixture.txt"), "base\n")
  await git(directory, "add", "fixture.txt")
  await git(
    directory,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "-m",
    "fixture base",
  )
  await git(directory, "switch", "--quiet", "--detach")
  await writeFile(path.join(directory, "fixture.txt"), "member work\n")
  await git(directory, "add", "fixture.txt")
  await git(
    directory,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "-m",
    "fixture member work",
  )
  const next = await git(directory, "rev-parse", "HEAD")
  await git(directory, "switch", "--quiet", "lead")
  const removals: boolean[] = []
  const worktrees = createNativeTeamWorktrees({
    location: { directory, project: { id: "native-project" } },
    worktree: {
      create: async (input) => {
        const target = path.join(input.directory, input.name)
        await git(directory, "worktree", "add", "--detach", target, "HEAD")
        return { directory: target }
      },
      list: async () => fixture.worktreePaths.map((directory) => ({ directory })),
      remove: async (input) => {
        removals.push(input.force)
        await git(directory, "worktree", "remove", ...(input.force ? ["--force"] : []), input.directory)
      },
    },
  })
  const owner = {}
  if (!worktrees) throw new Error("native fixture requires a host worktree domain")
  bindNativeTeamWorktrees(owner, worktrees)
  const identities = await Promise.all(fixture.worktreePaths.map((target) => worktrees.create(target)))
  await transitionRuntimeState(
    fixture.teamRunId,
    (state) => ({
      ...state,
      members: state.members.map((member) => {
        const identity = identities.find((entry) => entry.directory === member.worktreePath)
        return identity ? { ...member, nativeWorktree: identity, status: "completed" as const } : member
      }),
    }),
    fixture.config,
  )
  return { ...fixture, directory, git, next, worktrees, owner, removals }
}

export async function updateMemberStatuses(
  teamRunId: string,
  config: TeamModeConfig,
  statuses: Record<string, RuntimeState["members"][number]["status"]>,
): Promise<void> {
  await transitionRuntimeState(
    teamRunId,
    (runtimeState) => ({
      ...runtimeState,
      members: runtimeState.members.map((member) => ({
        ...member,
        status: statuses[member.name] ?? member.status,
      })),
    }),
    config,
  )
}

export async function readInboxMessages(teamRunId: string, memberName: string, config: TeamModeConfig) {
  const inboxDir = getInboxDir(resolveBaseDir(config), teamRunId, memberName)
  const fileNames = (await readdir(inboxDir)).filter((entry) => entry.endsWith(".json")).sort()
  return Promise.all(
    fileNames.map(async (fileName) => {
      const content = await readFile(path.join(inboxDir, fileName), "utf8")
      return MessageSchema.parse(JSON.parse(content))
    }),
  )
}

export function createTestMessage(overrides?: Partial<Parameters<typeof sendMessage>[0]>) {
  fixtureCounter += 1

  return MessageSchema.parse({
    version: 1,
    messageId: createUuid(fixtureCounter),
    from: "lead",
    to: "member-a",
    kind: "message",
    body: "hello",
    timestamp: Date.now(),
    ...overrides,
  })
}
