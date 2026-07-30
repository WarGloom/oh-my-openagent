import { describe, expect, it } from "bun:test"

import { computeView } from "./compute-view"
import { buildViewNodes, describeView } from "./render-view"
import type { ComputeViewSections } from "./compute-view"
import type { SidebarView } from "./state-types"

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

const activeSections: ComputeViewSections = {
  config: { kind: "invalid", messages: ["agents.sisyphus.model: expected string"] },
  roster: { kind: "empty" },
  agents: { kind: "list", agents: [{ name: "fixer", status: "busy" }] },
  jobs: { kind: "list", jobs: [{ title: "explore repo", status: "running", toolCalls: 3, lastTool: "grep" }] },
  teams: {
    kind: "list",
    teams: [{ name: "sidebar-team", leadSessionId: null, members: [{ name: "idle-member", status: "idle", work: "Reviewing sidebar", sessionId: null }] }],
  },
  loop: {
    kind: "live",
    goalsDone: 0,
    goalsTotal: 1,
    pass: 1,
    fail: 1,
    pending: 0,
    blocked: 0,
    activeGoal: "g1",
  },
}

describe("tui sidebar renderView", () => {
  it("#given active view #when building nodes #then it renders ULW Jobs and Team without the duplicate Agents section", () => {
    // given
    const view = computeView(activeSections)

    // when
    const description = describeView(view)
    const nodes = buildViewNodes(view, theme)

    // then
    expect(description).toContain("config invalid")
    expect(description.indexOf("ULW")).toBeLessThan(description.indexOf("Jobs"))
    expect(description.indexOf("Jobs")).toBeLessThan(description.indexOf("Team (1)"))
    expect(description).toContain("0/1")
    expect(description).toContain("pass 1")
    expect(description).toContain("fail 1")
    expect(description).not.toContain("Agents")
    expect(description).not.toContain("fixer")
    expect(description).toContain("explore repo")
    expect(description).toContain("• idle-member Reviewing sidebar · Idle")
    expect(nodes[0]?.kind).toBe("box")
  })

  it("#given a redacted active goal #when describing #then it reports the active goal as private", () => {
    // given
    if (activeSections.loop.kind !== "live") {
      throw new Error("expected a live loop fixture")
    }
    const view = computeView({
      ...activeSections,
      loop: { ...activeSections.loop, activeGoal: null },
    })

    // when
    const description = describeView(view)

    // then
    expect(description).toContain("active private")
    expect(description).not.toContain("active none")
  })

  it("#given broken view #when describing #then it includes config invalid and run doctor", () => {
    // given
    const view = computeView({
      config: { kind: "invalid", messages: ["agents.sisyphus.model: expected string"] },
      roster: { kind: "empty" },
      agents: { kind: "none" },
      jobs: { kind: "none" },
      teams: { kind: "none" },
      loop: { kind: "none" },
    })

    // when
    const description = describeView(view)

    // then
    expect(view.kind).toBe("broken")
    expect(description).toContain("config invalid")
    expect(description).toContain("run doctor")
    expect(description).toContain("agents.sisyphus.model")
  })

  it("#given idle view #when rendering #then it produces no OMO content", () => {
    // given
    const view: SidebarView = {
      kind: "idle",
      roster: { kind: "rows", rows: [{ label: "sisyphus", model: "gpt-5.5" }] },
    }

    // when
    const description = describeView(view)
    const nodes = buildViewNodes(view, theme)

    // then
    expect(description).toBe("")
    expect(nodes).toEqual([])
  })
})
