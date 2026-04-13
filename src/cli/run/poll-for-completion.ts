import pc from "picocolors"
import type { RunContext } from "./types"
import type { EventState } from "./events"
import { checkCompletionConditions } from "./completion"
import { normalizeSDKResponse } from "../../shared"
import { logRunTrace, runDebugIteration, traceRunStep } from "./run-debug"

const DEFAULT_POLL_INTERVAL_MS = 500
const DEFAULT_REQUIRED_CONSECUTIVE = 1
const ERROR_GRACE_CYCLES = 3
const MIN_STABILIZATION_MS = 1_000
const DEFAULT_EVENT_WATCHDOG_MS = 30_000 // 30 seconds
const DEFAULT_SECONDARY_MEANINGFUL_WORK_TIMEOUT_MS = 60_000 // 60 seconds
const MAX_STATUS_TIMEOUT_CYCLES = 3
const STATUS_TIMEOUT_MS = 5_000

export interface PollOptions {
  pollIntervalMs?: number
  requiredConsecutive?: number
  minStabilizationMs?: number
  eventWatchdogMs?: number
  secondaryMeaningfulWorkTimeoutMs?: number
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
  let consecutiveCompleteChecks = 0
  let errorCycleCount = 0
  let firstWorkTimestamp: number | null = null
  let secondaryTimeoutChecked = false
  let iteration = 0
  let consecutiveStatusTimeouts = 0
  const pollStartTimestamp = Date.now()

  logRunTrace(
    `pollForCompletion start (pollInterval=${pollIntervalMs}ms, requiredConsecutive=${requiredConsecutive})`,
  )

  while (!abortController.signal.aborted) {
    iteration += 1
    runDebugIteration(
      `pollForCompletion iteration=${iteration} aborted=${abortController.signal.aborted}`,
      iteration,
    )
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))

    if (abortController.signal.aborted) {
      logRunTrace(`pollForCompletion returning 130 due abort at iteration ${iteration}`)
      return 130
    }

    if (eventState.mainSessionError) {
      errorCycleCount++
      if (errorCycleCount >= ERROR_GRACE_CYCLES) {
        console.error(
          pc.red(`

Session ended with error: ${eventState.lastError}`)
        )
        console.error(
          pc.yellow("Check if todos were completed before the error.")
        )
        logRunTrace(`pollForCompletion returning 1 due main session error (iteration ${iteration})`)
        return 1
      }
      continue
    } else {
      errorCycleCount = 0
    }

    let mainSessionStatus: "idle" | "busy" | "retry" | null = null
    if (eventState.lastEventTimestamp !== null) {
      const timeSinceLastEvent = Date.now() - eventState.lastEventTimestamp
      if (timeSinceLastEvent > eventWatchdogMs) {
        console.log(
          pc.yellow(
            `
  No events for ${Math.round(
              timeSinceLastEvent / 1000
            )}s, verifying session status...`
          )
        )

        const statusProbe = await traceRunStep(`getMainSessionStatus (watchdog path, iteration=${iteration})`, () => getMainSessionStatus(ctx))
        mainSessionStatus = statusProbe.status
        if (statusProbe.timedOut) {
          consecutiveStatusTimeouts += 1
        } else {
          consecutiveStatusTimeouts = 0
        }
        if (consecutiveStatusTimeouts >= MAX_STATUS_TIMEOUT_CYCLES) {
          console.error(pc.red(`
Session status check timed out ${consecutiveStatusTimeouts} times in a row. Aborting run.`))
          logRunTrace(`pollForCompletion returning 1 due repeated status timeouts at iteration ${iteration}`)
          return 1
        }

        if (mainSessionStatus === "idle") {
          eventState.mainSessionIdle = true
        } else if (mainSessionStatus === "busy" || mainSessionStatus === "retry") {
          eventState.mainSessionIdle = false
        }

        eventState.lastEventTimestamp = Date.now()
      }
    }

    if (mainSessionStatus === null) {
      const statusProbe = await traceRunStep(`getMainSessionStatus (poll loop, iteration=${iteration})`, () => getMainSessionStatus(ctx))
      mainSessionStatus = statusProbe.status
      if (statusProbe.timedOut) {
        consecutiveStatusTimeouts += 1
      } else {
        consecutiveStatusTimeouts = 0
      }
      if (consecutiveStatusTimeouts >= MAX_STATUS_TIMEOUT_CYCLES) {
        console.error(pc.red(`
Session status check timed out ${consecutiveStatusTimeouts} times in a row. Aborting run.`))
        logRunTrace(`pollForCompletion returning 1 due repeated status timeouts at iteration ${iteration}`)
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
      if (Date.now() - pollStartTimestamp < minStabilizationMs) {
        consecutiveCompleteChecks = 0
        continue
      }

      if (
        Date.now() - pollStartTimestamp > secondaryMeaningfulWorkTimeoutMs &&
        !secondaryTimeoutChecked
      ) {
        secondaryTimeoutChecked = true
        const childrenRes = await ctx.client.session.children({
          path: { id: ctx.sessionID },
          query: { directory: ctx.directory },
        })
        const children = normalizeSDKResponse(childrenRes, [] as unknown[])
        const todosRes = await ctx.client.session.todo({
          path: { id: ctx.sessionID },
          query: { directory: ctx.directory },
        })
        const todos = normalizeSDKResponse(todosRes, [] as unknown[])

        const hasActiveChildren =
          Array.isArray(children) && children.length > 0
        const hasActiveTodos =
          Array.isArray(todos) &&
          todos.some(
            (t: unknown) =>
              (t as { status?: string })?.status !== "completed" &&
              (t as { status?: string })?.status !== "cancelled"
          )
        const hasActiveWork = hasActiveChildren || hasActiveTodos

        if (hasActiveWork) {
          eventState.hasReceivedMeaningfulWork = true
          console.log(
            pc.yellow(
              `
  No meaningful work events for ${Math.round(
                secondaryMeaningfulWorkTimeoutMs / 1000
              )}s but session has active work - assuming in progress`
            )
          )
        }
      }
    } else {
      if (firstWorkTimestamp === null) {
        firstWorkTimestamp = Date.now()
      }

      if (Date.now() - firstWorkTimestamp < minStabilizationMs) {
        consecutiveCompleteChecks = 0
        continue
      }
    }

    const shouldExit = await traceRunStep(`checkCompletionConditions (iteration=${iteration})`, () => checkCompletionConditions(ctx))
    if (shouldExit) {
      if (abortController.signal.aborted) {
        logRunTrace(`pollForCompletion returning 130 after check due abort at iteration ${iteration}`)
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

async function getMainSessionStatus(
  ctx: RunContext
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

    const statuses = normalizeSDKResponse(
      statusesRes,
      {} as Record<string, { type?: string }>
    )
    if (!(ctx.sessionID in statuses)) {
      return "idle"
    }
    const status = statuses[ctx.sessionID]?.type
    if (status === "idle" || status === "busy" || status === "retry") {
      return { status, timedOut: false }
    }
    return { status: null, timedOut: false }
  } catch (error) {
    const isTimeout =
      error instanceof Error && error.message.includes("Timed out while reading session status")
    if (isTimeout) {
      logRunTrace("getMainSessionStatus timed out")
    }
    return { status: null, timedOut: isTimeout }
  }
}
