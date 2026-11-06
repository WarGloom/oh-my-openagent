import { describe, expect, it } from "bun:test"
import { RGBA } from "@opentui/core"
import type { TestRendererOptions, TestRendererSetup } from "@opentui/core/testing"
import { createElement, insert, setProp, testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { materializeReactive } from "../tui"
import { buildDashboardFullViewNodes } from "./dashboard-full-view"
import {
  buildDashboardSidebarNodes,
  type DashboardData,
  type DashboardTheme,
  type DashboardViewState,
} from "./dashboard-view"

declare module "@opentui/solid" {
  function testRender(node: () => unknown, options?: TestRendererOptions): Promise<TestRendererSetup>
}

const ink = RGBA.fromHex("#eeeeee")
const surface = RGBA.fromHex("#202020")
const focused = RGBA.fromHex("#555555")
const color = { base: ink, hovered: ink, focused: ink, pressed: ink, selected: ink, disabled: ink, state: () => ink }
const background = { ...color, base: surface, hovered: focused, focused, pressed: focused }
const theme: DashboardTheme = {
  text: {
    base: ink,
    muted: ink,
    faint: ink,
    formfield: color,
    action: { primary: color, secondary: color, destructive: color },
    feedback: {
      error: { base: ink, muted: ink },
      warning: { base: ink, muted: ink },
      success: { base: ink, muted: ink },
      info: { base: ink, muted: ink },
    },
  },
  background: {
    base: surface,
    raised: { base: surface, high: surface, max: surface },
    formfield: background,
    action: { primary: background, secondary: background, destructive: background },
    feedback: {
      error: { base: surface },
      warning: { base: surface },
      success: { base: surface },
      info: { base: surface },
    },
  },
}
const snapshot: DashboardData = {
  tasks: {
    counts: { pending: 1, running: 1, completed: 0, error: 2, cancelled: 0, interrupt: 3 },
    rows: [
      { id: "queued", agent: "queue-worker", description: "Queued review", status: "pending" },
      {
        id: "live",
        agent: "render-worker",
        description: "Render dashboard",
        status: "running",
        sessionId: "native-task",
        toolCalls: 0,
        lastTool: "read",
      },
      { id: "interrupted", agent: "stopped-worker", description: "Interrupted work", status: "interrupt" },
    ],
  },
  monitors: {
    counts: { starting: 0, running: 0, exited: 1, stopped: 0, failed: 1 },
    rows: [
      { id: "build", label: "Compile unit", status: "exited", exitCode: 0 },
      { id: "check", label: "Failed check", status: "failed", exitCode: 7 },
    ],
  },
  teams: [
    {
      teamRunId: "team-run",
      teamName: "Rendering team",
      status: "active",
      members: [
        { name: "Known member", status: "running", sessionId: "native-member" },
        { name: "Unresolved member", status: "errored" },
      ],
      tasks: { pending: 2, claimed: 3, in_progress: 4, completed: 5, deleted: 6 },
    },
  ],
}
const navigation = { onOpenFullView: () => {}, onNavigateSession: (_id: string) => {} }
const solid = { createElement, insert, setProp }

describe("native dashboard rendering", () => {
  it("updates visible counts and active rows from the supplied snapshot", async () => {
    const [state, setState] = createSignal<DashboardViewState>({ kind: "ready", snapshot })
    const setup = await testRender(
      () => materializeReactive(() => buildDashboardSidebarNodes(state(), theme, navigation), solid),
      { width: 40, height: 50 },
    )
    try {
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain("1 running, 1 pending")
      expect(setup.captureCharFrame()).toContain("2 error")
      expect(setup.captureCharFrame()).toContain("3 interrupted")
      expect(setup.captureCharFrame()).toContain("1 failed")
      expect(setup.captureCharFrame().indexOf("render-worker")).toBeLessThan(
        setup.captureCharFrame().indexOf("queue-worker"),
      )
      setState({
        kind: "ready",
        snapshot: {
          ...snapshot,
          tasks: {
            counts: { pending: 0, running: 0, completed: 1, error: 0, cancelled: 0, interrupt: 0 },
            rows: [
              {
                ...snapshot.tasks.rows[1],
                id: "done",
                agent: "finished-worker",
                description: "Done review",
                status: "completed",
              },
            ],
          },
        },
      })
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain("0 running, 0 pending")
      expect(setup.captureCharFrame()).toContain("1 completed")
      expect(setup.captureCharFrame()).not.toContain("Render dashboard")
      expect(setup.captureCharFrame()).not.toContain("Queued review")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("renders every supplied detail and preserves zero progress and exit codes", async () => {
    const setup = await testRender(
      () =>
        materializeReactive(() => buildDashboardFullViewNodes({ kind: "ready", snapshot }, theme, navigation), solid),
      { width: 100, height: 70 },
    )
    try {
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      for (const row of snapshot.tasks.rows) {
        expect(frame).toContain(row.agent)
        expect(frame).toContain(row.description)
      }
      for (const row of snapshot.monitors.rows) expect(frame).toContain(row.label)
      for (const team of snapshot.teams) {
        expect(frame).toContain(team.teamName)
        for (const member of team.members) {
          expect(frame).toContain(member.name)
          expect(frame).toContain(member.status)
        }
      }
      expect(frame).toContain("0 tool calls")
      expect(frame).toContain("Last tool: read")
      expect(frame).toContain("exit 0")
      expect(frame).toContain("exit 7")
      expect(frame).toContain("2 pending, 3 claimed, 4 in progress, 5 completed, 6 deleted")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("opens full view with pointer and keyboard and navigates only supplied session IDs", async () => {
    const opened: string[] = []
    const setup = await testRender(
      () =>
        materializeReactive(
          () =>
            buildDashboardSidebarNodes({ kind: "ready", snapshot }, theme, {
              onOpenFullView: () => opened.push("full"),
              onNavigateSession: (id) => opened.push(id),
            }),
          solid,
        ),
      { width: 40, height: 50 },
    )
    try {
      await setup.renderOnce()
      await setup.mockMouse.click(2, 0)
      setup.mockInput.pressKey("RETURN")
      await setup.renderOnce()
      const row = setup
        .captureCharFrame()
        .split("\n")
        .findIndex((line) => line.includes("Render dashboard"))
      await setup.mockMouse.click(2, row)
      setup.mockInput.pressKey(" ")
      const queued = setup
        .captureCharFrame()
        .split("\n")
        .findIndex((line) => line.includes("Queued review"))
      await setup.mockMouse.click(2, queued)
      expect(opened).toEqual(["full", "full", "native-task", "native-task"])
    } finally {
      setup.renderer.destroy()
    }
  })

  it("navigates team members with known IDs while unresolved members remain text", async () => {
    const opened: string[] = []
    const setup = await testRender(
      () =>
        materializeReactive(
          () =>
            buildDashboardFullViewNodes({ kind: "ready", snapshot }, theme, {
              onNavigateSession: (id) => opened.push(id),
            }),
          solid,
        ),
      { width: 100, height: 70 },
    )
    try {
      await setup.renderOnce()
      const lines = setup.captureCharFrame().split("\n")
      await setup.mockMouse.click(
        2,
        lines.findIndex((line) => line.includes("Known member")),
      )
      await setup.mockMouse.click(
        2,
        lines.findIndex((line) => line.includes("Unresolved member")),
      )
      expect(opened).toEqual(["native-member"])
    } finally {
      setup.renderer.destroy()
    }
  })

  it("keeps loading, unavailable, error and authoritative empty states distinct", async () => {
    const [state, setState] = createSignal<DashboardViewState | null>({ kind: "loading" })
    const setup = await testRender(
      () => materializeReactive(() => buildDashboardSidebarNodes(state(), theme, navigation), solid),
      { width: 40, height: 40 },
    )
    try {
      await setup.renderOnce()
      const loading = setup.captureCharFrame()
      setState(null)
      await setup.renderOnce()
      const unavailable = setup.captureCharFrame()
      setState({ kind: "error", message: "Disconnected transport" })
      await setup.renderOnce()
      expect(setup.captureCharFrame().replace(/\s+/g, " ")).toContain("Disconnected transport")
      expect(setup.captureCharFrame()).not.toBe(unavailable)
      expect(unavailable).not.toBe(loading)
      setState({
        kind: "ready",
        snapshot: {
          tasks: { counts: { pending: 0, running: 0, completed: 0, error: 0, cancelled: 0, interrupt: 0 }, rows: [] },
          monitors: { counts: { starting: 0, running: 0, exited: 0, stopped: 0, failed: 0 }, rows: [] },
          teams: [],
        },
      })
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain("0 running, 0 pending")
      expect(setup.captureCharFrame()).not.toBe(loading)
      expect(setup.captureCharFrame()).not.toBe(unavailable)
    } finally {
      setup.renderer.destroy()
    }
  })

  it("wraps long names without displacing statuses at narrow native widths", async () => {
    const long = "界".repeat(30)
    const setup = await testRender(
      () =>
        materializeReactive(
          () =>
            buildDashboardFullViewNodes(
              {
                kind: "ready",
                snapshot: {
                  ...snapshot,
                  tasks: { ...snapshot.tasks, rows: [{ id: "wide", agent: long, description: long, status: "error" }] },
                },
              },
              theme,
              navigation,
            ),
          solid,
        ),
      { width: 24, height: 100 },
    )
    try {
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain("error /")
      expect(
        frame
          .split("\n")
          .filter((line) => line.includes("界"))
          .join("")
          .replaceAll(" ", ""),
      ).toContain(long + long)
      expect(frame).toContain("Compile unit")
      expect(frame).toContain("exit 0")
    } finally {
      setup.renderer.destroy()
    }
  })
})
