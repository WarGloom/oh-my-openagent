import type { Dirent } from "node:fs"
import { mkdir, readdir, rename, stat } from "node:fs/promises"
import path from "node:path"

import type { TeamModeConfig } from "../config"
import { getInboxDir, resolveBaseDir } from "../team-registry/paths"

export interface DeliveryReservation {
  readonly reservedPath: string
  readonly inboxPath: string
  readonly processedPath: string
  readonly processedDir: string
}

export type DeliveryReservationState = "inbox" | "reserved" | "processed" | "missing"

export type StaleDeliveryReservation = {
  readonly messageId: string
  readonly reservation: DeliveryReservation
}

type StaleReservationDiscoveryInput = {
  readonly teamRunId: string
  readonly recipientName: string
  readonly config: TeamModeConfig
  readonly staleTtlMs: number
}

const RESERVED_PREFIX = ".delivering-"
const RESERVED_SUFFIX = ".json"

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function buildReservation(inboxDir: string, messageId: string): DeliveryReservation {
  const inboxPath = path.join(inboxDir, `${messageId}.json`)
  const reservedPath = path.join(inboxDir, `${RESERVED_PREFIX}${messageId}${RESERVED_SUFFIX}`)
  const processedDir = path.join(inboxDir, "processed")
  const processedPath = path.join(processedDir, `${messageId}.json`)
  return { reservedPath, inboxPath, processedPath, processedDir }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw error
  }
}

export async function inspectDeliveryReservationState(
  teamRunId: string,
  recipientName: string,
  messageId: string,
  config: TeamModeConfig,
): Promise<DeliveryReservationState> {
  const inboxDir = getInboxDir(resolveBaseDir(config), teamRunId, recipientName)
  const reservation = buildReservation(inboxDir, messageId)
  if (await pathExists(reservation.reservedPath)) return "reserved"
  if (await pathExists(reservation.inboxPath)) return "inbox"
  if (await pathExists(reservation.processedPath)) return "processed"
  return "missing"
}

export async function reserveMessageForDelivery(
  teamRunId: string,
  recipientName: string,
  messageId: string,
  config: TeamModeConfig,
): Promise<DeliveryReservation | null> {
  const inboxDir = getInboxDir(resolveBaseDir(config), teamRunId, recipientName)
  const reservation = buildReservation(inboxDir, messageId)

  // Pre-reserved by sendMessage: confirm existence without renaming.
  try {
    await stat(reservation.reservedPath)
    return reservation
  } catch (error) {
    if (!isMissingPathError(error)) throw error
  }

  // Not pre-reserved: rename the unreserved file into the reserved slot.
  try {
    await rename(reservation.inboxPath, reservation.reservedPath)
    return reservation
  } catch (error) {
    if (isMissingPathError(error)) return null
    throw error
  }
}

export async function commitDeliveryReservation(reservation: DeliveryReservation): Promise<void> {
  await mkdir(reservation.processedDir, { recursive: true, mode: 0o700 })
  await rename(reservation.reservedPath, reservation.processedPath)
}

export async function releaseDeliveryReservation(reservation: DeliveryReservation): Promise<void> {
  await rename(reservation.reservedPath, reservation.inboxPath)
}

export async function discoverStaleDeliveryReservations(
  input: StaleReservationDiscoveryInput,
): Promise<StaleDeliveryReservation[]> {
  const inboxDir = getInboxDir(resolveBaseDir(input.config), input.teamRunId, input.recipientName)
  const cutoff = Date.now() - input.staleTtlMs
  const staleReservations: StaleDeliveryReservation[] = []
  let entries: Dirent[]
  try {
    entries = await readdir(inboxDir, { withFileTypes: true })
  } catch (error) {
    if (isMissingPathError(error)) return []
    throw error
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.startsWith(RESERVED_PREFIX) || !entry.name.endsWith(RESERVED_SUFFIX)) continue

    const filePath = path.join(inboxDir, entry.name)
    const fileStat = await stat(filePath)
    if (fileStat.mtimeMs > cutoff) continue

    const messageId = entry.name.slice(RESERVED_PREFIX.length, -RESERVED_SUFFIX.length)
    staleReservations.push({
      messageId,
      reservation: buildReservation(inboxDir, messageId),
    })
  }

  return staleReservations
}

export async function reclaimStaleReservations(
  teamRunId: string,
  recipientName: string,
  config: TeamModeConfig,
  staleTtlMs: number,
): Promise<string[]> {
  const staleReservations = await discoverStaleDeliveryReservations({
    teamRunId,
    recipientName,
    config,
    staleTtlMs,
  })
  const reclaimedIds: string[] = []

  for (const staleReservation of staleReservations) {
    try {
      await releaseDeliveryReservation(staleReservation.reservation)
      reclaimedIds.push(staleReservation.messageId)
    } catch {
      continue
    }
  }

  return reclaimedIds
}
