import { describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin/tui"
import { testRender } from "@opentui/solid"
import { MIRROR_SCHEMA_VERSION } from "../features/tui-sidebar/constants"
import { writeMirror } from "../features/tui-sidebar/mirror-io"
import { writeSessionJobsMirror } from "../features/tui-sidebar/session-jobs-mirror"
import tuiModule from "../tui"
import { setupV2Tui } from "./tui-setup"

describe("OpenCode 2.x TUI entry", () => {
  describe("#given the TUI default export", () => {
    it("#when both loaders inspect it #then it carries the 1.x tui callback and the 2.x setup callback", () => {
      // given
      const moduleShape = tuiModule

      // when
      const keys = Object.keys(moduleShape)

      // then
      expect(moduleShape.id).toBe("oh-my-openagent:tui")
      expect(typeof moduleShape.tui).toBe("function")
      expect(typeof moduleShape.setup).toBe("function")
      expect(keys).not.toContain("server")
    })
  })

  describe("#given a 2.x TUI context", () => {
    it("#when setup runs and is disposed #then it registers and unregisters the sidebar and event handlers", async () => {
      // given
      const claims: Parameters<Plugin.Context["ui"]["slot"]>[0][] = []
      const startTimer = spyOn(globalThis, "setInterval")
      const stopTimer = spyOn(globalThis, "clearInterval")
      let registered = true
      let subscriptions = 0
      const context = {
        location: { directory: process.cwd() },
        ui: { slot: (claim: Parameters<Plugin.Context["ui"]["slot"]>[0]) => {
          claims.push(claim)
          return () => { registered = false }
        } },
        data: { on: () => {
          subscriptions++
          return () => { subscriptions-- }
        } },
      }

      // when
      try {
        const cleanup = await Reflect.apply(setupV2Tui, undefined, [context])

        // then
        expect(claims).toHaveLength(1)
        expect(claims[0]?.append).toBe("sidebar.content")
        expect(subscriptions).toBe(3)
        expect(typeof cleanup).toBe("function")
        const timer = startTimer.mock.results.at(-1)?.value
        await cleanup()
        expect(registered).toBe(false)
        expect(subscriptions).toBe(0)
        expect(stopTimer).toHaveBeenCalledWith(timer)
      } finally {
        startTimer.mockRestore()
        stopTimer.mockRestore()
      }
    })

    it("#when a team member is clicked #then the router opens that member's session", async () => {
      // given
      const directory = mkdtempSync(join(tmpdir(), "omo-v2-sidebar-"))
      const previousDataHome = process.env.XDG_DATA_HOME
      process.env.XDG_DATA_HOME = join(directory, "data")
      writeMirror(directory, {
        version: MIRROR_SCHEMA_VERSION,
        projectDir: directory,
        updatedAt: Date.now(),
        activeAgents: [],
        loop: null,
        teams: [{ name: "team", leadSessionId: "lead", members: [
          { name: "member", status: "running", work: null, sessionId: "member-session" },
        ] }],
      })
      const claims: Parameters<Plugin.Context["ui"]["slot"]>[0][] = []
      const destinations: Parameters<Plugin.Context["ui"]["router"]["navigate"]>[0][] = []
      const color = "#ffffff"
      const context = {
        location: { directory },
        theme: { text: { base: color, muted: color, feedback: {
          error: { base: color }, warning: { base: color }, success: { base: color }, info: { base: color },
        } }, border: { base: color } },
        ui: {
          slot: (claim: Parameters<Plugin.Context["ui"]["slot"]>[0]) => { claims.push(claim); return () => {} },
          router: { navigate: (destination: Parameters<Plugin.Context["ui"]["router"]["navigate"]>[0]) => destinations.push(destination) },
        },
        data: { on: () => () => {}, session: { get: () => ({ location: { directory } }) } },
      }
      let cleanup: (() => void | Promise<void>) | undefined
      const tui = await import("../tui")
      const readView = spyOn(tui, "readView")
      try {
        cleanup = await Reflect.apply(setupV2Tui, undefined, [context])
        const claim = claims[0]
        if (!claim || claim.append !== "sidebar.content") throw new Error("sidebar slot missing")
        const initial = await testRender(() => claim.render({ sessionID: "lead" }), { width: 80, height: 20 })
        try {
          const pending = readView.mock.results[0]?.value
          if (!pending) throw new Error("sidebar did not start reading the view")
          await pending
        } finally {
          initial.renderer.destroy()
        }
        const app = await testRender(() => claim.render({ sessionID: "lead" }), { width: 80, height: 20 })
        try {
          const frame = await app.waitForFrame((text) => text.includes("member"))
          const lines = frame.split("\n")
          const row = lines.findIndex((line) => line.includes("member"))
          const column = lines[row]?.indexOf("member") ?? -1

          // when
          await app.mockMouse.click(column, row)

          // then
          expect(destinations).toEqual([{ type: "session", sessionID: "member-session" }])
        } finally {
          app.renderer.destroy()
        }
      } finally {
        readView.mockRestore()
        await cleanup?.()
        if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
        else process.env.XDG_DATA_HOME = previousDataHome
        rmSync(directory, { recursive: true, force: true })
      }
    })

    it("#when the current session belongs to another directory #then its jobs and monitors render without another session's activity", async () => {
      // given
      const directory = mkdtempSync(join(tmpdir(), "omo-v2-activity-"))
      const sessionDirectory = mkdtempSync(join(directory, "project-"))
      const previousDataHome = process.env.XDG_DATA_HOME
      process.env.XDG_DATA_HOME = join(directory, "data")
      writeSessionJobsMirror(sessionDirectory, "current", [
        { title: "current job", status: "running", toolCalls: 3, lastTool: "read" },
      ], Date.now(), ["current monitor"])
      writeSessionJobsMirror(sessionDirectory, "other", [
        { title: "other job", status: "pending", toolCalls: 0, lastTool: null },
      ], Date.now(), ["other monitor"])
      const claims: Parameters<Plugin.Context["ui"]["slot"]>[0][] = []
      const color = "#ffffff"
      const context = {
        location: { directory },
        theme: { text: { base: color, muted: color, feedback: {
          error: { base: color }, warning: { base: color }, success: { base: color }, info: { base: color },
        } }, border: { base: color } },
        ui: { slot: (claim: Parameters<Plugin.Context["ui"]["slot"]>[0]) => { claims.push(claim); return () => {} } },
        data: { on: () => () => {}, session: { get: () => ({ location: { directory: sessionDirectory } }) } },
      }
      let cleanup: (() => void | Promise<void>) | undefined
      const tui = await import("../tui")
      const readView = spyOn(tui, "readView")
      try {
        cleanup = await Reflect.apply(setupV2Tui, undefined, [context])
        const claim = claims[0]
        if (!claim || claim.append !== "sidebar.content") throw new Error("sidebar slot missing")

        // when
        const initial = await testRender(() => claim.render({ sessionID: "current" }), { width: 80, height: 20 })
        try {
          const pending = readView.mock.results[0]?.value
          if (!pending) throw new Error("sidebar did not start reading the view")
          await pending
        } finally {
          initial.renderer.destroy()
        }
        const app = await testRender(() => claim.render({ sessionID: "current" }), { width: 80, height: 20 })
        try {
          await app.renderOnce()

          // then
          const frame = app.captureCharFrame()
          expect(frame).toContain("current job running 3 read")
          expect(frame).toContain("current monitor")
          expect(frame).not.toContain("other job")
          expect(frame).not.toContain("other monitor")
        } finally {
          app.renderer.destroy()
        }
      } finally {
        readView.mockRestore()
        await cleanup?.()
        if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
        else process.env.XDG_DATA_HOME = previousDataHome
        rmSync(directory, { recursive: true, force: true })
      }
    })
  })
})
