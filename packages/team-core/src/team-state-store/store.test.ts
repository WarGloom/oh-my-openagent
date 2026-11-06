/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { TeamModeConfigSchema } from "../config"
import type { TeamModeConfig } from "../config"
import { RuntimeStateSchema } from "../types"
import type { ActiveTeamSummary, RuntimeState, TeamSpec } from "../types"
import { subscribeTeamRuntimeChanges } from "./changes"
import { removeRuntimeDirectory } from "./runtime-cleanup"
import {
  InvalidTransitionError,
  RuntimeStateError,
  STALE_DELETING_TTL_MS,
  createRuntimeState,
  listActiveTeams,
  loadRuntimeState,
  saveRuntimeState,
  transitionRuntimeState,
  transitionRuntimeStateAsync,
} from "./store"

async function createTemporaryBaseDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "team-mode-store-"))
}

function createConfig(baseDir: string): TeamModeConfig {
  return TeamModeConfigSchema.parse({
    base_dir: baseDir,
    max_members: 6,
    max_parallel_members: 3,
    max_messages_per_run: 200,
    max_wall_clock_minutes: 45,
    max_member_turns: 50,
  })
}

function createSpec(name = `team-${randomUUID().slice(0, 8)}`): TeamSpec {
  return {
    version: 1,
    name,
    createdAt: Date.now(),
    leadAgentId: "lead",
    members: [
      {
        kind: "subagent_type",
        name: "lead",
        subagent_type: "sisyphus",
        backendType: "in-process",
        isActive: true,
        color: "red",
      },
      {
        kind: "category",
        name: "worker",
        category: "deep",
        prompt: "implement task",
        backendType: "in-process",
        isActive: true,
        color: "blue",
      },
    ],
  }
}

async function seedRuntimeState(
  runtimeState: RuntimeState,
  config: TeamModeConfig,
  saveRuntimeState: (runtimeState: RuntimeState, config: TeamModeConfig) => Promise<void>,
): Promise<void> {
  await mkdir(path.join(config.base_dir ?? "", "runtime", runtimeState.teamRunId), { recursive: true })
  await saveRuntimeState(runtimeState, config)
}

async function runtimeDirectoryExists(baseDir: string, teamRunId: string): Promise<boolean> {
  try {
    await stat(path.join(baseDir, "runtime", teamRunId))
    return true
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException
    if (nodeError.code === "ENOENT") return false
    throw error
  }
}

describe("runtime state store", () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(async (directoryPath) => {
      await rm(directoryPath, { recursive: true, force: true })
    }))
  })

  for (const status of ["failed", "deleted", "deleting"] as const)
  test(`discovery preserves nested current and archived member work for ${status} runtimes`, async () => {
    // given
    const baseDir = await createTemporaryBaseDir()
    temporaryDirectories.push(baseDir)
    const config = createConfig(baseDir)
    const state = await createRuntimeState(createSpec(), "lead-session", "project", config)
    const runtimeDirectory = path.join(baseDir, "runtime", state.teamRunId)
    const currentDirectory = path.join(runtimeDirectory, "current-member")
    const archivedDirectory = path.join(runtimeDirectory, "archived-member")
    await Promise.all([currentDirectory, archivedDirectory].map(async (directory) => {
      await mkdir(directory)
      await writeFile(path.join(directory, "work.txt"), "member work")
    }))
    await saveRuntimeState({ ...state, status,
      members: state.members.map((member) => member.name === "worker" ? { ...member, worktreePath: currentDirectory } : member),
      removedMembers: [{ member: { name: "archived", agentType: "general-purpose", status: "completed", pendingInjectedMessageIds: [],
        nativeWorktree: { projectID: "native-project", directory: archivedDirectory } }, operationId: randomUUID(), removedAt: Date.now(), requeuedTaskIds: [] }],
    }, config)
    if (status === "deleting") {
      const stale = new Date(Date.now() - STALE_DELETING_TTL_MS - 1000)
      await utimes(path.join(runtimeDirectory, "state.json"), stale, stale)
    }

    // when
    const teams = await listActiveTeams(config)

    // then
    expect(teams).toEqual([])
    expect(await Promise.all([currentDirectory, archivedDirectory].map((directory) => readFile(path.join(directory, "work.txt"), "utf8")))).toEqual(["member work", "member work"])
    expect(existsSync(path.join(runtimeDirectory, "state.json"))).toBe(false)
  })

  for (const relative of [false, true])
  test(`explicit cleanup preserves member paths through a symlinked base (relative=${relative})`, async () => {
    // given
    const projectDirectory = await createTemporaryBaseDir()
    temporaryDirectories.push(projectDirectory)
    const realBase = path.join(projectDirectory, "data")
    const linkedBase = path.join(projectDirectory, ".omo")
    await mkdir(realBase)
    await symlink(realBase, linkedBase, "dir")
    const config = createConfig(linkedBase)
    const state = await createRuntimeState(createSpec(), "lead-session", "project", config)
    const directory = path.join(realBase, "runtime", state.teamRunId, "member")
    await mkdir(directory)
    await writeFile(path.join(directory, "work.txt"), "symlinked member work")
    const worktreePath = relative ? path.relative(projectDirectory, directory) : await realpath(directory)
    await saveRuntimeState({ ...state, projectDirectory,
      members: state.members.map((member) => member.name === "worker" ? { ...member, worktreePath } : member),
    }, config)

    // when
    const removed = await removeRuntimeDirectory(state.teamRunId, config)

    // then
    expect(removed).toBe(true)
    expect(await readFile(path.join(directory, "work.txt"), "utf8")).toBe("symlinked member work")
    expect(existsSync(path.join(linkedBase, "runtime", state.teamRunId, "state.json"))).toBe(false)
  })

  test("createRuntimeState persists creating state with computed bounds", async () => {
    // given
    const baseDir = await createTemporaryBaseDir()
    temporaryDirectories.push(baseDir)
    const config = createConfig(baseDir)

    // when
    const runtimeState = await createRuntimeState(createSpec(), undefined, "user", config)
    const persistedState = JSON.parse(await readFile(path.join(baseDir, "runtime", runtimeState.teamRunId, "state.json"), "utf8"))

    // then
    expect(runtimeState.teamRunId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(runtimeState.status).toBe("creating")
    expect(runtimeState.leadSessionId).toBeUndefined()
    expect(runtimeState.bounds).toEqual({
      maxMembers: 6,
      maxParallelMembers: 3,
      maxMessagesPerRun: 200,
      maxWallClockMinutes: 45,
      maxMemberTurns: 50,
    })
    expect(runtimeState.members).toEqual([
      expect.objectContaining({ name: "lead", agentType: "leader", status: "pending", pendingInjectedMessageIds: [] }),
      expect.objectContaining({ name: "worker", agentType: "general-purpose", status: "pending", pendingInjectedMessageIds: [] }),
    ])
    expect(persistedState.status).toBe("creating")
  })

  test("loadRuntimeState throws RuntimeStateError for malformed state", async () => {
    // given
    const baseDir = await createTemporaryBaseDir()
    temporaryDirectories.push(baseDir)
    const config = createConfig(baseDir)
    const teamRunId = randomUUID()
    await mkdir(path.join(baseDir, "runtime", teamRunId), { recursive: true })
    await writeFile(path.join(baseDir, "runtime", teamRunId, "state.json"), "{not-json")

    // when
    const result = loadRuntimeState(teamRunId, config)

    // then
    expect(result).rejects.toBeInstanceOf(RuntimeStateError)
  })

  test("transitionRuntimeState allows active to shutdown_requested", async () => {
    // given
    const baseDir = await createTemporaryBaseDir()
    temporaryDirectories.push(baseDir)
    const config = createConfig(baseDir)
    const createdState = await createRuntimeState(createSpec(), "lead-session", "project", config)

    // when
    await transitionRuntimeState(createdState.teamRunId, (runtimeState) => ({ ...runtimeState, status: "active" }), config)
    const runtimeState = await transitionRuntimeState(
      createdState.teamRunId,
      (currentRuntimeState) => ({ ...currentRuntimeState, status: "shutdown_requested" }),
      config,
    )

    // then
    expect(runtimeState.status).toBe("shutdown_requested")
    expect((await loadRuntimeState(createdState.teamRunId, config)).status).toBe("shutdown_requested")
  })

  test("transitionRuntimeState rejects reverse transition", async () => {
    // given
    const baseDir = await createTemporaryBaseDir()
    temporaryDirectories.push(baseDir)
    const config = createConfig(baseDir)
    const createdState = await createRuntimeState(createSpec(), undefined, "user", config)
    await seedRuntimeState({ ...createdState, status: "deleted" }, config, saveRuntimeState)

    // when
    const result = transitionRuntimeState(
      createdState.teamRunId,
      (runtimeState) => ({ ...runtimeState, status: "active" }),
      config,
    )

    // then
    expect(result).rejects.toBeInstanceOf(InvalidTransitionError)
    expect((await loadRuntimeState(createdState.teamRunId, config)).status).toBe("deleted")
  })

  test("loadRuntimeState ignores crash-left tmp files and keeps valid persisted state", async () => {
    // given
    const baseDir = await createTemporaryBaseDir()
    temporaryDirectories.push(baseDir)
    const config = createConfig(baseDir)
    const runtimeState = await createRuntimeState(createSpec(), undefined, "user", config)
    const statePath = path.join(baseDir, "runtime", runtimeState.teamRunId, "state.json")
    await writeFile(`${statePath}.tmp.mock-crash`, JSON.stringify({ ...runtimeState, status: "active" }))

    // when
    const persistedState = await loadRuntimeState(runtimeState.teamRunId, config)

    // then
    expect(persistedState.status).toBe("creating")
  })

  test("loadRuntimeState accepts legacy member delegate counters without preserving them", async () => {
    // given
    const baseDir = await createTemporaryBaseDir()
    temporaryDirectories.push(baseDir)
    const config = createConfig(baseDir)
    const runtimeState = await createRuntimeState(createSpec(), undefined, "user", config)
    const statePath = path.join(baseDir, "runtime", runtimeState.teamRunId, "state.json")
    await writeFile(statePath, JSON.stringify({
      ...runtimeState,
      members: runtimeState.members.map((member) => ({ ...member, delegateTaskCallsUsed: 3 })),
    }))

    // when
    const persistedState = await loadRuntimeState(runtimeState.teamRunId, config)

    // then
    expect(persistedState.members).toHaveLength(2)
    expect(Object.keys(persistedState.members[0] ?? {})).not.toContain("delegateTaskCallsUsed")
  })

  test("listActiveTeams skips malformed runtime states and logs them", async () => {
    // given
    const baseDir = await createTemporaryBaseDir()
    temporaryDirectories.push(baseDir)
    const config = createConfig(baseDir)
    const firstState = await createRuntimeState(createSpec("alpha-team"), undefined, "user", config)
    const secondState = await createRuntimeState(createSpec("beta-team"), undefined, "project", config)
    const malformedTeamRunId = randomUUID()
    await mkdir(path.join(baseDir, "runtime", malformedTeamRunId), { recursive: true })
    await writeFile(path.join(baseDir, "runtime", malformedTeamRunId, "state.json"), "{oops")

    // when
    const activeTeams = await listActiveTeams(config)

    // then
    expect(activeTeams).toEqual([
      { teamRunId: firstState.teamRunId, teamName: "alpha-team", status: "creating", memberCount: 2, scope: "user" },
      { teamRunId: secondState.teamRunId, teamName: "beta-team", status: "creating", memberCount: 2, scope: "project" },
    ])
  })

  test("#given an active runtime with a lead session w2tc #when active teams are listed #then the typed summary carries leadSessionId", async () => {
    // given
    const baseDir = await createTemporaryBaseDir()
    temporaryDirectories.push(baseDir)
    const config = createConfig(baseDir)
    const runtimeState = await createRuntimeState(createSpec("lead-session-team"), "lead-session-14", "project", config)

    // when
    const activeTeams = await listActiveTeams(config)
    const summary: ActiveTeamSummary | undefined = activeTeams[0]

    // then
    expect(summary).toEqual({
      teamRunId: runtimeState.teamRunId,
      teamName: "lead-session-team",
      status: "creating",
      memberCount: 2,
      scope: "project",
      leadSessionId: "lead-session-14",
    })
  })

  test("listActiveTeams removes deleted runtime directories left by interrupted cleanup", async () => {
    // given
    const baseDir = await createTemporaryBaseDir()
    temporaryDirectories.push(baseDir)
    const config = createConfig(baseDir)
    const runtimeState = await createRuntimeState(createSpec("deleted-team"), undefined, "user", config)
    await saveRuntimeState({ ...runtimeState, status: "deleted" }, config)

    // when
    const activeTeams = await listActiveTeams(config)

    // then
    expect(activeTeams).toEqual([])
    expect(await runtimeDirectoryExists(baseDir, runtimeState.teamRunId)).toBe(false)
  })

  test("listActiveTeams removes deleting runtimes that have been stuck past the stale timeout", async () => {
    // given
    const baseDir = await createTemporaryBaseDir()
    temporaryDirectories.push(baseDir)
    const config = createConfig(baseDir)
    const runtimeState = await createRuntimeState(createSpec("stuck-delete-team"), undefined, "user", config)
    await saveRuntimeState({ ...runtimeState, status: "deleting" }, config)
    const staleTimestamp = new Date(Date.now() - STALE_DELETING_TTL_MS - 1_000)
    await utimes(path.join(baseDir, "runtime", runtimeState.teamRunId, "state.json"), staleTimestamp, staleTimestamp)

    // when
    const activeTeams = await listActiveTeams(config)

    // then
    expect(activeTeams).toEqual([])
    expect(await runtimeDirectoryExists(baseDir, runtimeState.teamRunId)).toBe(false)
  })
})

type ObservedRuntimeChange = { readonly teamRunId: string; readonly status: RuntimeState["status"] | "absent" }

type RuntimeChangeCase = {
  readonly operation: string
  readonly arrange: (config: TeamModeConfig) => Promise<() => Promise<string>>
  readonly expectedStatus: ObservedRuntimeChange["status"] | undefined
}

async function createdRun(config: TeamModeConfig, status?: RuntimeState["status"]): Promise<RuntimeState> {
  const runtimeState = await createRuntimeState(createSpec(), undefined, "user", config)
  if (status === undefined) return runtimeState
  const updatedState = { ...runtimeState, status }
  await saveRuntimeState(updatedState, config)
  return updatedState
}

const runtimeChangeCases: readonly RuntimeChangeCase[] = [
  {
    operation: "createRuntimeState",
    arrange: async (config) => async () => (await createRuntimeState(createSpec(), undefined, "user", config)).teamRunId,
    expectedStatus: "creating",
  },
  {
    operation: "saveRuntimeState",
    arrange: async (config) => {
      const runtimeState = await createdRun(config)
      return async () => { await saveRuntimeState({ ...runtimeState, status: "active" }, config); return runtimeState.teamRunId }
    },
    expectedStatus: "active",
  },
  {
    operation: "transitionRuntimeState",
    arrange: async (config) => {
      const { teamRunId } = await createdRun(config)
      return async () => (await transitionRuntimeState(teamRunId, (state) => ({ ...state, status: "active" }), config)).teamRunId
    },
    expectedStatus: "active",
  },
  {
    operation: "transitionRuntimeStateAsync",
    arrange: async (config) => {
      const { teamRunId } = await createdRun(config)
      return async () => (await transitionRuntimeStateAsync(teamRunId, async (state) => ({ ...state, status: "failed" }), config)).teamRunId
    },
    expectedStatus: "failed",
  },
  {
    operation: "listActiveTeams removing a deleted runtime",
    arrange: async (config) => {
      const { teamRunId } = await createdRun(config, "deleted")
      return async () => { await listActiveTeams(config); return teamRunId }
    },
    expectedStatus: "absent",
  },
  {
    operation: "removeRuntimeDirectory",
    arrange: async (config) => {
      const { teamRunId } = await createdRun(config)
      return async () => { await removeRuntimeDirectory(teamRunId, config); return teamRunId }
    },
    expectedStatus: "absent",
  },
  {
    operation: "a rejected transition",
    arrange: async (config) => {
      const { teamRunId } = await createdRun(config, "deleted")
      return async () => {
        await expect(transitionRuntimeState(teamRunId, (state) => ({ ...state, status: "active" }), config))
          .rejects.toBeInstanceOf(InvalidTransitionError)
        return teamRunId
      }
    },
    expectedStatus: undefined,
  },
]

describe("runtime state change notifications", () => {
  const temporaryDirectories: string[] = []
  const unsubscribers: Array<() => void> = []

  afterEach(async () => {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
    await Promise.all(temporaryDirectories.splice(0).map(async (directoryPath) => {
      await rm(directoryPath, { recursive: true, force: true })
    }))
  })

  test.each(runtimeChangeCases)("#given a subscriber #when $operation finishes #then it sees exactly the committed state", async ({ arrange, expectedStatus }) => {
    // given
    const baseDir = await createTemporaryBaseDir()
    temporaryDirectories.push(baseDir)
    const config = createConfig(baseDir)
    const act = await arrange(config)
    const observed: ObservedRuntimeChange[] = []
    unsubscribers.push(subscribeTeamRuntimeChanges((teamRunId) => {
      const statePath = path.join(baseDir, "runtime", teamRunId, "state.json")
      const status = existsSync(statePath) ? readPersistedStatus(readFileSync(statePath, "utf8")) : "absent"
      observed.push({ teamRunId, status })
    }))

    // when
    const teamRunId = await act()

    // then
    expect(observed).toEqual(expectedStatus === undefined ? [] : [{ teamRunId, status: expectedStatus }])
  })

  test("#given listeners that unsubscribe during a notification #when later runtimes commit #then removed listeners are never called again", async () => {
    // given
    const baseDir = await createTemporaryBaseDir()
    temporaryDirectories.push(baseDir)
    const config = createConfig(baseDir)
    const calls: string[] = []
    let unsubscribeSecond: () => void = () => undefined
    const unsubscribeFirst = subscribeTeamRuntimeChanges(() => {
      calls.push("first")
      unsubscribeFirst()
      unsubscribeSecond()
    })
    unsubscribeSecond = subscribeTeamRuntimeChanges(() => { calls.push("second") })
    unsubscribers.push(unsubscribeFirst, unsubscribeSecond)

    // when
    await createRuntimeState(createSpec(), undefined, "user", config)
    await createRuntimeState(createSpec(), undefined, "user", config)

    // then
    expect(calls).toEqual(["first"])
  })

  test("#given a throwing listener #when a runtime commits #then the commit resolves and later listeners still run", async () => {
    // given
    const baseDir = await createTemporaryBaseDir()
    temporaryDirectories.push(baseDir)
    const config = createConfig(baseDir)
    const notified: string[] = []
    unsubscribers.push(
      subscribeTeamRuntimeChanges(() => { throw new Error("listener failure") }),
      subscribeTeamRuntimeChanges((teamRunId) => { notified.push(teamRunId) }),
    )

    // when
    const runtimeState = await createRuntimeState(createSpec(), undefined, "user", config)

    // then
    expect(notified).toEqual([runtimeState.teamRunId])
  })
})

function readPersistedStatus(stateContent: string): RuntimeState["status"] {
  return RuntimeStateSchema.parse(JSON.parse(stateContent)).status
}
