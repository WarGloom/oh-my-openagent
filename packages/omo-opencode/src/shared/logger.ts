import { configureSharedSubunitLogger, createLogger, type LoggerTestOverrides } from "@oh-my-opencode/utils"

import { LOG_FILENAME } from "./plugin-identity"

const logger = createLogger({ logFileName: LOG_FILENAME })

export const log = logger.log
export const getLogFilePath = logger.getLogFilePath

configureSharedSubunitLogger(log)

export function _setLoggerForTesting(overrides: LoggerTestOverrides): void {
  logger._setLoggerForTesting(overrides)
}

export function _resetLoggerForTesting(): void {
  logger._resetLoggerForTesting()
}

/** @internal test-only seam: legacy reset name used by test setup */
export function _resetForTesting(): void {
  _resetLoggerForTesting()
}

/** @internal test-only seam: synchronously flush the buffer */
export function _flushForTesting(): void {
  logger._flushForTesting()
}
