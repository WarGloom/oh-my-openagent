import { log } from "../../shared/logger"
import { resolveSessionEventID } from "../../shared/event-session-id"
import { HOOK_NAME } from "./constants"
import type { RalphLoopState } from "./types"

type LoopStateController = {
	getState: () => RalphLoopState | null
	clear: () => boolean
}

export function handleDeletedLoopSession(
	props: Record<string, unknown> | undefined,
	loopState: LoopStateController,
): boolean {
	const sessionID = resolveSessionEventID(props)
	if (!sessionID) return false

	const state = loopState.getState()
	if (state?.session_id === sessionID) {
		loopState.clear()
		log(`[${HOOK_NAME}] Session deleted, loop cleared`, { sessionID })
	}
	return true
}

function extractErrorMessage(error: { message?: string; data?: unknown } | undefined): string | undefined {
	if (!error) return undefined
	if (typeof error.message === "string" && error.message.length > 0) {
		return error.message
	}

	const data = error.data as { message?: unknown } | undefined
	return typeof data?.message === "string" ? data.message : undefined
}

export function isAgentResolutionError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) {
		return false
	}

	return extractErrorMessage(error as { message?: string; data?: unknown })?.includes("Agent not found:") ?? false
}

export function handleErroredLoopSession(
	props: Record<string, unknown> | undefined,
	loopState: LoopStateController,
): boolean {
	const sessionID = resolveSessionEventID(props)
	const error = props?.error as { name?: string; message?: string; data?: unknown } | undefined
	const errorName = error?.name
	const errorMessage = extractErrorMessage(error)

	if (errorName === "MessageAbortedError") {
		if (sessionID) {
			const state = loopState.getState()
			if (state?.session_id === sessionID) {
				loopState.clear()
				log(`[${HOOK_NAME}] User aborted, loop cleared`, { sessionID })
			}
		}
		return true
	}

	if (sessionID && isAgentResolutionError(error)) {
		const state = loopState.getState()
		if (state?.session_id === sessionID) {
			loopState.clear()
			log(`[${HOOK_NAME}] Agent resolution failed, loop cleared`, {
				sessionID,
				errorName,
				errorMessage,
			})
		}
		return true
	}

	if (sessionID) {
		log(`[${HOOK_NAME}] Session error ignored, loop remains active`, {
			sessionID,
			errorName,
			errorMessage,
		})
	}
	return true
}
