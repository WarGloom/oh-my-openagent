import { describe, expect, it } from "bun:test"

import { teamLines, teamNodes } from "./team-section"
import type { ViewNode } from "./element-helpers"
import type { TeamsState } from "./state-types"

const theme = {
  accent: "accent",
  borderSubtle: "border",
  error: "error",
  info: "info",
  success: "success",
  text: "text",
  textMuted: "muted",
  warning: "warning",
}

function isMouseHandler(value: unknown): value is (event: { stopPropagation: () => void }) => void {
  return typeof value === "function"
}

function memberRows(nodes: readonly ViewNode[]): readonly ViewNode[] {
  return nodes.slice(1)
}

describe("team sidebar section", () => {
  it("#given expanded teams with valid and missing member sessions #when rendering #then it shows Activity-like rows and navigates only valid rows without bubbling", () => {
    // given
    const teams: TeamsState = {
      kind: "list",
      teams: [
        {
          name: "sidebar-team",
          leadSessionId: "ses-running",
          members: [
            { name: "sisyphus", status: "running", work: "Implementing sidebar", sessionId: "ses-running" },
            { name: "atlas", status: "idle", work: null, sessionId: null },
          ],
        },
      ],
    }
    const navigatedSessionIds: string[] = []
    let toggleCount = 0

    // when
    const nodes = teamNodes(teams, theme, {
      collapsed: false,
      onToggle: () => {
        toggleCount += 1
      },
      onNavigateSession: (sessionId) => {
        navigatedSessionIds.push(sessionId)
      },
    })
    const [header, idleRow, navigableRow] = nodes
    const navigateHandler = navigableRow?.props.onMouseDown
    const toggleHandler = header?.props.onMouseDown
    let propagationStopped = false

    // then
    expect(nodes).toHaveLength(3)
    expect(header?.text).toBeUndefined()
    expect(header?.children).toEqual([{ kind: "text", props: { fg: "text" }, text: "Team (2) ▼" }])
    expect(memberRows(nodes)).toHaveLength(2)
    expect(navigableRow?.kind).toBe("box")
    expect(navigableRow?.props.flexDirection).toBe("row")
    expect(navigableRow?.props.gap).toBe(1)
    expect(navigableRow?.children).toEqual([
      { kind: "text", props: { fg: "success" }, text: "•" },
      { kind: "text", props: { fg: "text", flexShrink: 0, wrapMode: "none" }, text: "sisyphus" },
      {
        kind: "text",
        props: { fg: "muted", flexGrow: 1, flexShrink: 1, overflow: "hidden", truncate: true, wrapMode: "none" },
        text: "Implementing sidebar · ",
      },
      { kind: "text", props: { fg: "muted", flexShrink: 0, wrapMode: "none" }, text: "Running" },
    ])
    expect(idleRow?.props.onMouseDown).toBeUndefined()
    if (!isMouseHandler(toggleHandler)) {
      throw new Error("team header was not interactive")
    }
    if (!isMouseHandler(navigateHandler)) {
      throw new Error("member row was not interactive")
    }
    toggleHandler({ stopPropagation: () => undefined })
    navigateHandler({
      stopPropagation: () => {
        propagationStopped = true
      },
    })
    expect(toggleCount).toBe(1)
    expect(propagationStopped).toBe(true)
    expect(navigatedSessionIds).toEqual(["ses-running"])
  })

  it("#given collapsed teams #when rendering #then it keeps only the foldable Team header", () => {
    // given
    const teams: TeamsState = {
      kind: "list",
      teams: [{ name: "sidebar-team", leadSessionId: null, members: [{ name: "idle", status: "idle", work: null, sessionId: null }] }],
    }

    // when
    const nodes = teamNodes(teams, theme, {
      collapsed: true,
      onToggle: () => undefined,
      onNavigateSession: () => undefined,
    })

    // then
    expect(memberRows(nodes)).toHaveLength(0)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.children).toEqual([{ kind: "text", props: { fg: "text" }, text: "Team (1) ▶" }])
  })

  it("#given long Team names #when rendering a member row #then it preserves the Team identity after the member name", () => {
    // given
    const teams: TeamsState = {
      kind: "list",
      teams: [{
          name: "team-name-that-must-remain-visible-for-identity",
          leadSessionId: null,
          members: [{
          name: "member",
          status: "running",
          work: null,
          sessionId: null,
        }],
      }],
    }

    // when
    const memberLine = teamLines(teams)[1]

    // then
    expect(memberLine).toBe("• member team-name-that-must-remain-visible-for-identity · Running")
  })

  it("#given member status and work updates #when rendering #then rows remain one line in deterministic member-name order", () => {
    // given
    const first: TeamsState = {
      kind: "list",
      teams: [{
        name: "sidebar-team",
        leadSessionId: "ses-sisyphus",
        members: [
          { name: "sisyphus", status: "running", work: "Running", sessionId: "ses-sisyphus" },
          { name: "atlas", status: "idle", work: null, sessionId: "ses-atlas" },
        ],
      }],
    }
    const second: TeamsState = {
      kind: "list",
      teams: [{
        ...first.teams[0],
        members: [
          { name: "sisyphus", status: "completed", work: null, sessionId: "ses-sisyphus" },
          { name: "atlas", status: "running", work: "Updated", sessionId: "ses-atlas" },
        ],
      }],
    }

    // when
    const firstRows = memberRows(teamNodes(first, theme))
    const secondRows = memberRows(teamNodes(second, theme))

    // then
    expect(firstRows).toHaveLength(2)
    expect(secondRows).toHaveLength(2)
    expect(firstRows.map((row) => row.children?.[1]?.text)).toEqual(["atlas", "sisyphus"])
    expect(secondRows.map((row) => row.children?.[1]?.text)).toEqual(["atlas", "sisyphus"])
    expect(firstRows.every((row) => row.props.height === 1)).toBe(true)
    expect(secondRows.every((row) => row.props.height === 1)).toBe(true)
  })
})
