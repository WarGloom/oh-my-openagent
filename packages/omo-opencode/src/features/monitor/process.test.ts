import { afterEach, describe, expect, test } from "bun:test"

import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { readProcessStream } from "../../shared/process-stream-reader"
import { spawnMonitoredProcess, type SpawnDeps, type TimerHandle } from "./process"

type PipeSubprocess = Bun.Subprocess<"ignore", "pipe", "pipe">

interface TimerCall {
  handle: TimerHandle
  fn: () => void
  ms: number
  cleared: boolean
}

interface SpawnCall {
  command: string[]
  options: Bun.SpawnOptions.SpawnOptions<"ignore", "pipe", "pipe"> | undefined
}

function createTextStream(text = ""): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (text.length > 0) {
        controller.enqueue(new TextEncoder().encode(text))
      }
      controller.close()
    },
  })
}

function createFakeSubprocess(input: {
  pid?: number
  exited: Promise<number>
  stdout?: string
  stderr?: string
  signalCode?: NodeJS.Signals | null
}): PipeSubprocess {
  const stdout = createTextStream(input.stdout)
  const stderr = createTextStream(input.stderr)

  return {
    stdin: undefined,
    stdout,
    stderr,
    stdio: [null, null, null],
    readable: stdout,
    terminal: undefined,
    pid: input.pid ?? 3919,
    exited: input.exited,
    exitCode: null,
    signalCode: input.signalCode ?? null,
    killed: false,
    kill() {},
    ref() {},
    unref() {},
    send(_message: unknown) {},
    disconnect() {},
    resourceUsage() {
      return undefined
    },
    async [Symbol.asyncDispose]() {},
  }
}

function createFakeClock(): {
  deps: Pick<SpawnDeps, "setTimer" | "clearTimer">
  calls: TimerCall[]
  fireByMs(ms: number): void
} {
  let nextHandle = 1
  const calls: TimerCall[] = []

  return {
    deps: {
      setTimer(fn, ms) {
        const handle = nextHandle
        nextHandle += 1
        calls.push({ handle, fn, ms, cleared: false })
        return handle
      },
      clearTimer(handle) {
        const call = calls.find((entry) => entry.handle === handle)
        if (call) {
          call.cleared = true
        }
      },
    },
    calls,
    fireByMs(ms) {
      const call = calls.find((entry) => entry.ms === ms && !entry.cleared)
      if (!call) {
        throw new Error(`No active timer for ${ms}ms`)
      }
      call.fn()
    },
  }
}

function createFakeSpawn(processes: PipeSubprocess[], calls: SpawnCall[]): typeof Bun.spawn {
  const fakeSpawn = (
    command: string[],
    options?: Bun.SpawnOptions.SpawnOptions<"ignore", "pipe", "pipe">,
  ): PipeSubprocess => {
    calls.push({ command, options })
    const nextProcess = processes.shift()
    if (!nextProcess) {
      throw new Error("fake spawn called without a queued process")
    }
    return nextProcess
  }

  return unsafeTestValue<typeof Bun.spawn>(fakeSpawn)
}

const originalProcessKill = process.kill

afterEach(() => {
  process.kill = originalProcessKill
})

describe("spawnMonitoredProcess", () => {
  describe("#given a running subprocess", () => {
    test("#when kill runs #then it kills the process group and escalates after grace", () => {
      // given
      const pendingExit = new Promise<number>(() => {})
      const subprocess = createFakeSubprocess({ pid: 4321, exited: pendingExit })
      const spawnCalls: SpawnCall[] = []
      const clock = createFakeClock()
      const killCalls: Array<{ pid: number; signal: string | number | undefined }> = []
      process.kill = ((pid: number, signal?: string | number) => {
        killCalls.push({ pid, signal })
        return true
      }) satisfies typeof process.kill

      const monitored = spawnMonitoredProcess(
        { command: "bun test", maxRuntimeMs: 60_000 },
        { spawn: createFakeSpawn([subprocess], spawnCalls), ...clock.deps },
      )

      // when
      monitored.kill("SIGTERM")
      clock.fireByMs(5_000)

      // then
      expect(killCalls).toEqual([
        { pid: -4321, signal: "SIGTERM" },
        { pid: -4321, signal: "SIGKILL" },
      ])
    })

    test("#when manually stopped before the deadline and exit is delayed past it #then exit is not a timeout", async () => {
      // given
      let resolveExit!: (code: number) => void
      const delayedExit = new Promise<number>((resolve) => { resolveExit = resolve })
      const subprocess = createFakeSubprocess({ pid: 4322, exited: delayedExit, signalCode: "SIGTERM" })
      const clock = createFakeClock()
      process.kill = ((_pid: number, _signal?: string | number) => true) satisfies typeof process.kill
      const monitored = spawnMonitoredProcess(
        { command: "sleep 2", maxRuntimeMs: 25 },
        { spawn: createFakeSpawn([subprocess], []), ...clock.deps },
      )

      // when
      monitored.kill()
      for (const timer of clock.calls.filter((entry) => !entry.cleared).sort((a, b) => a.ms - b.ms)) {
        timer.fn()
      }
      resolveExit(0)
      const result = await monitored.exited

      // then
      expect(result).toEqual({ code: 0, signal: "SIGTERM" })
      expect(result).not.toHaveProperty("terminationReason")
    })
  })

  describe("#given a subprocess exits immediately", () => {
    test("#when awaiting exited #then it resolves with the exit code and signal data", async () => {
      // given
      const subprocess = createFakeSubprocess({ exited: Promise.resolve(127) })
      const spawnCalls: SpawnCall[] = []
      const clock = createFakeClock()

      // when
      const monitored = spawnMonitoredProcess(
        { command: "missing-command", maxRuntimeMs: 60_000 },
        { spawn: createFakeSpawn([subprocess], spawnCalls), ...clock.deps },
      )
      const result = await monitored.exited

      // then
      expect(result).toEqual({ code: 127, signal: null })
      expect(clock.calls.find((call) => call.ms === 60_000)?.cleared).toBe(true)
    })
  })

  describe("#given max runtime expires before process exit", () => {
    test("#when watchdog fires #then it kills the group and resolves as SIGALRM", async () => {
      // given
      const pendingExit = new Promise<number>(() => {})
      const subprocess = createFakeSubprocess({ pid: 2468, exited: pendingExit })
      const spawnCalls: SpawnCall[] = []
      const clock = createFakeClock()
      const killCalls: Array<{ pid: number; signal: string | number | undefined }> = []
      process.kill = ((pid: number, signal?: string | number) => {
        killCalls.push({ pid, signal })
        return true
      }) satisfies typeof process.kill

      const monitored = spawnMonitoredProcess(
        { command: "bun test", maxRuntimeMs: 1234 },
        { spawn: createFakeSpawn([subprocess], spawnCalls), ...clock.deps },
      )

      // when
      clock.fireByMs(1234)
      const result = await monitored.exited

      // then
      expect(result).toEqual({ code: null, signal: "SIGALRM", terminationReason: "timeout", maxRuntimeMs: 1234 })
      expect(killCalls).toEqual([{ pid: -2468, signal: "SIGTERM" }])
      clock.fireByMs(5_000)
      expect(killCalls).toEqual([
        { pid: -2468, signal: "SIGTERM" },
        { pid: -2468, signal: "SIGKILL" },
      ])
    })
  })

  describe("#given a command is spawned", () => {
    test("#when inspecting spawn args #then stdin is ignored and output is piped", () => {
      // given
      const subprocess = createFakeSubprocess({ exited: Promise.resolve(0) })
      const spawnCalls: SpawnCall[] = []
      const clock = createFakeClock()

      // when
      spawnMonitoredProcess(
        { command: "printf 'ok'", cwd: "/tmp", env: { OMO_TEST: "1" }, maxRuntimeMs: 60_000 },
        { spawn: createFakeSpawn([subprocess], spawnCalls), ...clock.deps },
      )

      // then
      expect(spawnCalls).toEqual([
        {
          command: ["printf", "ok"],
          options: {
            cwd: "/tmp",
            env: { OMO_TEST: "1" },
            detached: true,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          },
        },
      ])
    })
  })
})

describe("spawnMonitoredProcess real subprocess smoke", () => {
  test.skipIf(process.platform === "win32")("#given a sleeping command #when the short runtime elapses #then exit identifies the timeout", async () => {
    // given
    const monitored = spawnMonitoredProcess(
      { command: "sleep 2", maxRuntimeMs: 25 },
      { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (handle) => clearTimeout(handle) },
    )

    // when
    const exit = await monitored.exited

    // then
    expect(exit).toEqual({ code: null, signal: "SIGALRM", terminationReason: "timeout", maxRuntimeMs: 25 })
  })

  test.skipIf(process.platform === "win32")("#given printf emits two lines #when monitored #then stdout lines arrive and no process group remains", async () => {
    // given
    let observedPid: number | undefined
    const recordingSpawn = (
      command: string[],
      options?: Bun.SpawnOptions.SpawnOptions<"ignore", "pipe", "pipe">,
    ): PipeSubprocess => {
      const subprocess = Bun.spawn<"ignore", "pipe", "pipe">(command, options)
      observedPid = subprocess.pid
      return subprocess
    }

    // when
    const monitored = spawnMonitoredProcess(
      { command: "printf 'a\nb\n'", maxRuntimeMs: 60_000 },
      {
        spawn: unsafeTestValue<typeof Bun.spawn>(recordingSpawn),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (handle) => clearTimeout(handle),
      },
    )
    const [stdout, exit] = await Promise.all([
      readProcessStream(monitored.stdout),
      monitored.exited,
    ])

    // then
    expect(stdout.split("\n").filter(Boolean)).toEqual(["a", "b"])
    expect(exit.code).toBe(0)
    expect(observedPid).toBeDefined()
    let groupExists = true
    try {
      process.kill(-(observedPid ?? 0), 0)
    } catch (error) {
      void error
      groupExists = false
    }
    expect(groupExists).toBe(false)
  })
})
