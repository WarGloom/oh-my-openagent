import pc from "picocolors"
import type { RunContext } from "./types"
import type { EventState } from "./events"
import { checkCompletionConditions } from "./completion"
import { isRecord, normalizeSDKResponse } from "../../shared"
import { logRunTrace, runDebugIteration, traceRunStep } from "./run-debug"

const DEFAULT_POLL_INTERVAL_MS = 500
const DEFAULT_REQUIRED_CONSECUTIVE = 1
const ERROR_GRACE_CYCLES = 3
const MIN_STABILIZATION_MS = 1_000
const DEFAULT_EVENT_WATCHDOG_MS = 30_000 // 30 seconds
const DEFAULT_SECONDARY_MEANINGFUL_WORK_TIMEOUT_MS = 60_000 // 60 seconds
const MAX_STATUS_TIMEOUT_CYCLES = 3
const STATUS_TIMEOUT_MS = 5_000

type SessionStatusMap = Record<string, { type?: string }>

function isIncompleteTodo(value: unknown): boolean {
  if (!isRecord(value)) {
    return true
  }

  const status = value.status
  return status !== "completed" && status !== "cancelled"
}

export interface PollOptions {
  pollIntervalMs?: number
  requiredConsecutive?: number
  minStabilizationMs?: number
  eventWatchdogMs?: number
  secondaryMeaningfulWorkTimeoutMs?: number
  requireMeaningfulWork?: boolean
  /** Injectable clock (default Date.now). Tests drive a virtual clock to assert timing causality deterministically. */
  now?: () => number
  /** Injectable poll delay (default real setTimeout). Tests advance the virtual clock here instead of sleeping. */
  sleep?: (ms: number) => Promise<void>
}

type MainSessionStatusProbe = {
  status: "idle" | "busy" | "retry" | null
  timedOut: boolean
}

export async function pollForCompletion(
  ctx: RunContext,
  eventState: EventState,
  abortController: AbortController,
  options: PollOptions = {},
): Promise<number> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const requiredConsecutive =
    options.requiredConsecutive ?? DEFAULT_REQUIRED_CONSECUTIVE
  const rawMinStabilizationMs =
    options.minStabilizationMs ?? MIN_STABILIZATION_MS
  const minStabilizationMs =
    rawMinStabilizationMs > 0 ? rawMinStabilizationMs : MIN_STABILIZATION_MS
  const eventWatchdogMs =
    options.eventWatchdogMs ?? DEFAULT_EVENT_WATCHDOG_MS
  const secondaryMeaningfulWorkTimeoutMs =
    options.secondaryMeaningfulWorkTimeoutMs ??
    DEFAULT_SECONDARY_MEANINGFUL_WORK_TIMEOUT_MS
  const requireMeaningfulWork = options.requireMeaningfulWork ?? false
  const now = options.now ?? Date.now
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let consecutiveCompleteChecks = 0
  let errorCycleCount = 0
  let firstWorkTimestamp: number | null = null
  let secondaryTimeoutChecked = false
  let iteration = 0
  let consecutiveStatusTimeouts = 0
  const pollStartTimestamp = now()

  logRunTrace(
    `pollForCompletion start (pollInterval=${pollIntervalMs}ms, requiredConsecutive=${requiredConsecutive})`,
  )

  while (!abortController.signal.aborted) {
    iteration += 1
    runDebugIteration(
      `pollForCompletion iteration=${iteration} aborted=${abortController.signal.aborted}`,
      iteration,
    )
    await sleep(pollIntervalMs)

    if (abortController.signal.aborted) {
      logRunTrace(
        `pollForCompletion returning 130 due abort at iteration ${iteration}`,
      )
      return 130
    }

    if (eventState.mainSessionError) {
      // A session.error is only terminal while the session stays idle:
      // runtime fallback rearms the session (status "busy"/"retry") after
      // retryable errors, so a live recovery clears the latch (#3745).
      const statusDuringError = (await getMainSessionStatus(ctx)).status
      if (statusDuringError === "busy" || statusDuringError === "retry") {
        eventState.mainSessionError = false
        eventState.mainSessionIdle = false
        errorCycleCount = 0
        continue
      }
      errorCycleCount++
      if (errorCycleCount >= ERROR_GRACE_CYCLES) {
        console.error(
          pc.red(`

Session ended with error: ${eventState.lastError}`),
        )
        console.error(
          pc.yellow("Check if todos were completed before the error."),
        )
        logRunTrace(
          `pollForCompletion returning 1 due main session error (iteration ${iteration})`,
        )
        return 1
      }
      continue
    } else {
      errorCycleCount = 0
    }

    let mainSessionStatus: "idle" | "busy" | "retry" | null = null
    if (eventState.lastEventTimestamp !== null) {
      const timeSinceLastEvent = now() - eventState.lastEventTimestamp
      if (timeSinceLastEvent > eventWatchdogMs) {
        console.log(
          pc.yellow(
            `
  No events for ${Math.round(
              timeSinceLastEvent / 1000,
            )}s, verifying session status...`,
          ),
        )

        const statusProbe = await traceRunStep(
          `getMainSessionStatus (watchdog path, iteration=${iteration})`,
          () => getMainSessionStatus(ctx),
        )
        mainSessionStatus = statusProbe.status
        if (statusProbe.timedOut) {
          consecutiveStatusTimeouts += 1
        } else {
          consecutiveStatusTimeouts = 0
        }
        if (consecutiveStatusTimeouts >= MAX_STATUS_TIMEOUT_CYCLES) {
          console.error(pc.red(`
Session status check timed out ${consecutiveStatusTimeouts} times in a row. Aborting run.`))
          logRunTrace(
            `pollForCompletion returning 1 due repeated status timeouts at iteration ${iteration}`,
          )
          return 1
        }

        if (mainSessionStatus === "idle") {
          eventState.mainSessionIdle = true
        } else if (
          mainSessionStatus === "busy" ||
          mainSessionStatus === "retry"
        ) {
          eventState.mainSessionIdle = false
        }

        eventState.lastEventTimestamp = now()
      }
    }

    if (mainSessionStatus === null) {
      const statusProbe = await traceRunStep(
        `getMainSessionStatus (poll loop, iteration=${iteration})`,
        () => getMainSessionStatus(ctx),
      )
      mainSessionStatus = statusProbe.status
      if (statusProbe.timedOut) {
        consecutiveStatusTimeouts += 1
      } else {
        consecutiveStatusTimeouts = 0
      }
      if (consecutiveStatusTimeouts >= MAX_STATUS_TIMEOUT_CYCLES) {
        console.error(pc.red(`
Session status check timed out ${consecutiveStatusTimeouts} times in a row. Aborting run.`))
        logRunTrace(
          `pollForCompletion returning 1 due repeated status timeouts at iteration ${iteration}`,
        )
        return 1
      }
    }
    if (mainSessionStatus === "busy" || mainSessionStatus === "retry") {
      eventState.mainSessionIdle = false
    } else if (mainSessionStatus === "idle") {
      eventState.mainSessionIdle = true
    }

    if (!eventState.mainSessionIdle) {
      consecutiveCompleteChecks = 0
      continue
    }

    if (eventState.currentTool !== null) {
      consecutiveCompleteChecks = 0
      continue
    }

    if (!eventState.hasReceivedMeaningfulWork) {
      if (now() - pollStartTimestamp < minStabilizationMs) {
        consecutiveCompleteChecks = 0
        continue
      }

      if (requireMeaningfulWork) {
        if (now() - pollStartTimestamp <= secondaryMeaningfulWorkTimeoutMs) {
          consecutiveCompleteChecks = 0
          continue
        }

        const hasActiveWork = await hasActiveSessionWork(ctx)
        if (hasActiveWork) {
          consecutiveCompleteChecks = 0
          continue
        }

        console.error(
          pc.red(
            "\n\nSession never produced assistant output, tool activity, or reasoning after the prompt started.",
          ),
        )
        return 1
      }

      if (
        now() - pollStartTimestamp > secondaryMeaningfulWorkTimeoutMs &&
        !secondaryTimeoutChecked
      ) {
        secondaryTimeoutChecked = true
        const hasActiveWork = await hasActiveSessionWork(ctx)

        if (hasActiveWork) {
          eventState.hasReceivedMeaningfulWork = true
          console.log(
            pc.yellow(
              `
  No meaningful work events for ${Math.round(
                secondaryMeaningfulWorkTimeoutMs / 1000,
              )}s but session has active work - assuming in progress`,
            ),
          )
        }
      }
    } else {
      if (firstWorkTimestamp === null) {
        firstWorkTimestamp = now()
      }

      if (now() - firstWorkTimestamp < minStabilizationMs) {
        consecutiveCompleteChecks = 0
        continue
      }
    }

    const shouldExit = await traceRunStep(
      `checkCompletionConditions (iteration=${iteration})`,
      () => checkCompletionConditions(ctx),
    )
    if (shouldExit) {
      if (abortController.signal.aborted) {
        logRunTrace(
          `pollForCompletion returning 130 after check due abort at iteration ${iteration}`,
        )
        return 130
      }

      consecutiveCompleteChecks++
      if (consecutiveCompleteChecks >= requiredConsecutive) {
        console.log(pc.green("\n\nAll tasks completed."))
        logRunTrace(`pollForCompletion returning 0 at iteration ${iteration}`)
        return 0
      }
    } else {
      consecutiveCompleteChecks = 0
    }
  }

  logRunTrace(`pollForCompletion returning 130 after loop exited`)
  return 130
}

async function hasActiveSessionWork(ctx: RunContext): Promise<boolean> {
  const childrenRes = await ctx.client.session.children({
    path: { id: ctx.sessionID },
    query: { directory: ctx.directory },
  })
  const children = normalizeSDKResponse<unknown[]>(childrenRes, [])
  const todosRes = await ctx.client.session.todo({
    path: { id: ctx.sessionID },
    query: { directory: ctx.directory },
  })
  const todos = normalizeSDKResponse<unknown[]>(todosRes, [])

  const hasActiveChildren = Array.isArray(children) && children.length > 0
  const hasActiveTodos = Array.isArray(todos) && todos.some(isIncompleteTodo)
  return hasActiveChildren || hasActiveTodos
}

async function getMainSessionStatus(
  ctx: RunContext,
): Promise<MainSessionStatusProbe> {
  try {
    let timeout: ReturnType<typeof setTimeout> | null = null
    const statusesRes = await Promise.race([
      ctx.client.session.status({
        query: { directory: ctx.directory },
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Timed out while reading session status"))
        }, STATUS_TIMEOUT_MS)
        timeout.unref?.()
      }),
    ])

    if (timeout) {
      clearTimeout(timeout)
    }

    const statuses = normalizeSDKResponse<SessionStatusMap>(statusesRes, {})
    if (!(ctx.sessionID in statuses)) {
      return { status: "idle", timedOut: false }
    }
    const status = statuses[ctx.sessionID]?.type
    if (status === "idle" || status === "busy" || status === "retry") {
      return { status, timedOut: false }
    }
    return { status: null, timedOut: false }
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error
    }
    const isTimeout =
      error.message.includes("Timed out while reading session status")
    if (isTimeout) {
      logRunTrace("getMainSessionStatus timed out")
    }
    return { status: null, timedOut: isTimeout }
  }
}
