/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test"

import { MIRROR_SCHEMA_VERSION } from "./constants"
import { parseSnapshot } from "./snapshot-schema"
import type { TuiRuntimeSnapshot } from "./snapshot-schema"

describe("TuiRuntimeSnapshotSchema", () => {
  it("#given a valid snapshot #when parsed #then it round-trips the typed value", () => {
    // given
    const snapshot: TuiRuntimeSnapshot = {
      version: MIRROR_SCHEMA_VERSION,
      projectDir: "/tmp/project",
      updatedAt: 1_718_000_000,
      activeAgents: [
        { name: "sisyphus", status: "running" },
        { name: "atlas", status: "retry" },
      ],
      loop: {
        kind: "live",
        goalsDone: 2,
        goalsTotal: 4,
        pass: 5,
        fail: 1,
        pending: 3,
        blocked: 1,
        activeGoal: "Render sidebar",
      },
      teams: [],
    }

    // when
    const parsed = parseSnapshot(snapshot)

    // then
    expect(parsed).toEqual(snapshot)
  })

  it("#given a version mismatch #when parsed #then it returns null", () => {
    // given
    const raw = {
      version: 0,
      projectDir: "/tmp/project",
      updatedAt: 1,
      activeAgents: [],
      loop: null,
    }

    // when
    const parsed = parseSnapshot(raw)

    // then
    expect(parsed).toBeNull()
  })

  it("#given a legacy global v1 mirror and a current v2 mirror #when parsed #then v1 is rejected and v2 round-trips", () => {
    // given
    const legacyV1 = {
      version: 1,
      projectDir: "/tmp/project",
      updatedAt: 1,
      activeAgents: [],
      jobBoard: [{ title: "stale global job", status: "running", toolCalls: 1, lastTool: "grep" }],
      loop: null,
      teams: [],
    }
    const currentV2: TuiRuntimeSnapshot = {
      version: 2 as const,
      projectDir: "/tmp/project",
      updatedAt: 1,
      activeAgents: [],
      loop: null,
      teams: [],
    }

    // when
    const legacyParsed = parseSnapshot(legacyV1)
    const currentParsed = parseSnapshot(currentV2)

    // then
    expect(legacyParsed).toBeNull()
    expect(currentParsed).toEqual(currentV2)
  })

  it("#given a v2 mirror without teams #when parsed #then it supplies the additive empty teams projection", () => {
    // given
    const legacySnapshot = {
      version: MIRROR_SCHEMA_VERSION,
      projectDir: "/tmp/project",
      updatedAt: 1,
      activeAgents: [],
      loop: null,
    }

    // when
    const parsed = parseSnapshot(legacySnapshot)

    // then
    expect(parsed).toMatchObject({ teams: [] })
  })

  it("#given a Team row from a mirror written before lead session identity #when parsed #then it defaults leadSessionId to null", () => {
    // given
    const legacyTeamSnapshot = {
      version: MIRROR_SCHEMA_VERSION,
      projectDir: "/tmp/project",
      updatedAt: 1,
      activeAgents: [],
      loop: null,
      teams: [{
        name: "legacy-team",
        members: [],
      }],
    }

    // when
    const parsed = parseSnapshot(legacyTeamSnapshot)

    // then
    expect(parsed?.teams).toEqual([{ name: "legacy-team", leadSessionId: null, members: [] }])
  })

  it("#given a snapshot without projectDir #when parsed #then it returns null", () => {
    // given
    const raw = {
      version: MIRROR_SCHEMA_VERSION,
      updatedAt: 1,
      activeAgents: [],
      loop: null,
    }

    // when
    const parsed = parseSnapshot(raw)

    // then
    expect(parsed).toBeNull()
  })

  it("#given a non-object value #when parsed #then it returns null", () => {
    // given
    const raw = "not a snapshot"

    // when
    const parsed = parseSnapshot(raw)

    // then
    expect(parsed).toBeNull()
  })
})
