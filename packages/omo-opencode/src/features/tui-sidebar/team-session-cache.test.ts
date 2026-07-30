/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test"

import { TeamSessionCache } from "./team-session-cache"
import type { TeamRow, TeamsState } from "./state-types"

const alphaTeam: TeamRow = {
  name: "alpha-team",
  leadSessionId: "ses-alpha-lead",
  members: [
    { name: "alpha-lead", status: "running", work: "Lead alpha", sessionId: "ses-alpha-lead" },
    { name: "alpha-member", status: "pending", work: null, sessionId: "ses-alpha-member" },
  ],
}

const betaTeam: TeamRow = {
  name: "beta-team",
  leadSessionId: "ses-beta-lead",
  members: [
    { name: "beta-lead", status: "running", work: "Lead beta", sessionId: "ses-beta-lead" },
    { name: "beta-member", status: "idle", work: null, sessionId: "ses-beta-member" },
  ],
}

function list(teams: readonly TeamRow[]): TeamsState {
  return { kind: "list", teams }
}

describe("Team session cache", () => {
  it("#given no Team snapshot #when selecting a session before team creation #then it renders no Team state", () => {
    // given
    const cache = new TeamSessionCache()

    // when
    const teams = cache.forSession("ses-alpha-lead")

    // then
    expect(teams).toEqual({ kind: "none" })
  })

  it("#given two project Teams #when indexing and switching between lead and member sessions #then each session renders only its matching Team", () => {
    // given
    const cache = new TeamSessionCache()
    cache.update(list([betaTeam, alphaTeam]))

    // when
    const renderedByRoute = [
      cache.forSession("ses-alpha-lead"),
      cache.forSession("ses-alpha-member"),
      cache.forSession("ses-beta-member"),
      cache.forSession("ses-unrelated"),
      cache.forSession(null),
    ]

    // then
    expect(renderedByRoute).toEqual([
      list([alphaTeam]),
      list([alphaTeam]),
      list([betaTeam]),
      { kind: "none" },
      { kind: "none" },
    ])
  })

  it("#given a cached Team #when a later mirror has no Teams #then the current session retains its cached Team", () => {
    // given
    const cache = new TeamSessionCache()
    cache.update(list([alphaTeam]))

    // when
    cache.update({ kind: "none" })

    // then
    expect(cache.forSession("ses-alpha-lead")).toEqual(list([alphaTeam]))
  })

  it("#given a cached Team #when a replacement Team uses the same lead route session #then the route renders only the replacement", () => {
    // given
    const cache = new TeamSessionCache()
    const replacementTeam: TeamRow = {
      ...betaTeam,
      name: "replacement-team",
      leadSessionId: "ses-alpha-lead",
      members: [{ ...betaTeam.members[0], sessionId: "ses-alpha-lead" }],
    }
    cache.update(list([alphaTeam]))

    // when
    cache.update(list([replacementTeam]))

    // then
    expect(cache.forSession("ses-alpha-lead")).toEqual(list([replacementTeam]))
    expect(cache.forSession("ses-alpha-member")).toEqual({ kind: "none" })
  })

  it("#given a cached Team member #when a newer Team update removes that member #then its session no longer receives the Team", () => {
    // given
    const cache = new TeamSessionCache()
    cache.update(list([alphaTeam]))
    const updatedAlpha: TeamRow = {
      ...alphaTeam,
      members: [{ name: "alpha-lead", status: "completed", work: null, sessionId: "ses-alpha-lead" }],
    }

    // when
    cache.update(list([updatedAlpha]))

    // then
    expect(cache.forSession("ses-alpha-member")).toEqual({ kind: "none" })
    expect(cache.forSession("ses-alpha-lead")).toEqual(list([updatedAlpha]))
  })
})
