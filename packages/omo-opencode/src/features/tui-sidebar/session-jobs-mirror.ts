import { createHash } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import { z } from "zod"

import { writeFileAtomically } from "../../shared/write-file-atomically"
import { STALE_MS } from "./constants"
import { canonicalProjectDir, mirrorStorageDir } from "./mirror-path"
import type { JobRow } from "./state-types"

const SESSION_JOBS_MIRROR_VERSION = 1
const HASH_LENGTH = 16

const BACKGROUND_TASK_STATUS_VALUES = [
  "pending",
  "running",
  "completed",
  "error",
  "cancelled",
  "interrupt",
] as const satisfies readonly JobRow["status"][]

const JobRowSchema = z
  .object({
    title: z.string(),
    status: z.enum(BACKGROUND_TASK_STATUS_VALUES),
    toolCalls: z.number().int().nonnegative().nullable(),
    lastTool: z.string().nullable(),
  })
  .strict() satisfies z.ZodType<JobRow>

const SessionJobsMirrorSchema = z
  .object({
    version: z.literal(SESSION_JOBS_MIRROR_VERSION),
    projectDir: z.string(),
    parentSessionId: z.string(),
    updatedAt: z.number(),
    jobs: z.array(JobRowSchema),
  })
  .strict()

class SessionJobsMirrorPathError extends Error {
  constructor(readonly parentPath: string) {
    super(`Session Jobs mirror parent resolves through a symlink: ${parentPath}`)
    this.name = "SessionJobsMirrorPathError"
  }
}

function hashedPathSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, HASH_LENGTH)
}

function sessionJobsMirrorFilePath(projectDir: string, parentSessionId: string): string {
  return join(
    mirrorStorageDir(),
    "jobs",
    hashedPathSegment(canonicalProjectDir(projectDir)),
    `${hashedPathSegment(parentSessionId)}.json`,
  )
}

function hasDirectParent(filePath: string): boolean {
  const parentPath = dirname(filePath)
  return realpathSync.native(parentPath) === resolve(parentPath)
}

export function writeSessionJobsMirror(
  projectDir: string,
  parentSessionId: string,
  jobs: readonly JobRow[],
  now: number = Date.now(),
): void {
  const canonicalDir = canonicalProjectDir(projectDir)
  const filePath = sessionJobsMirrorFilePath(canonicalDir, parentSessionId)
  const parentPath = dirname(filePath)
  const jobsPath = dirname(parentPath)
  const payload = SessionJobsMirrorSchema.parse({
    version: SESSION_JOBS_MIRROR_VERSION,
    projectDir: canonicalDir,
    parentSessionId,
    updatedAt: now,
    jobs,
  })

  mkdirSync(jobsPath, { recursive: true })
  if (!hasDirectParent(parentPath)) {
    throw new SessionJobsMirrorPathError(jobsPath)
  }
  mkdirSync(parentPath, { recursive: true })
  if (!hasDirectParent(filePath)) {
    throw new SessionJobsMirrorPathError(parentPath)
  }
  writeFileAtomically(filePath, JSON.stringify(payload), { mode: 0o600 })
}

export function readSessionJobsMirror(
  projectDir: string,
  parentSessionId: string,
  now: number = Date.now(),
): readonly JobRow[] | null {
  const canonicalDir = canonicalProjectDir(projectDir)
  const filePath = sessionJobsMirrorFilePath(canonicalDir, parentSessionId)
  let raw: unknown
  try {
    if (lstatSync(filePath).isSymbolicLink() || !hasDirectParent(filePath)) {
      return null
    }
    raw = JSON.parse(readFileSync(filePath, "utf-8"))
  } catch (error) {
    if (error instanceof Error) {
      return null
    }
    throw error
  }

  const parsed = SessionJobsMirrorSchema.safeParse(raw)
  if (!parsed.success) {
    return null
  }
  if (parsed.data.projectDir !== canonicalDir || parsed.data.parentSessionId !== parentSessionId) {
    return null
  }
  if (now - parsed.data.updatedAt > STALE_MS) {
    return null
  }
  return parsed.data.jobs
}
