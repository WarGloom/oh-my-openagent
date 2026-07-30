/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

import { STALE_MS } from "./constants"
import { canonicalProjectDir, mirrorStorageDir } from "./mirror-path"
import { readSessionJobsMirror, writeSessionJobsMirror } from "./session-jobs-mirror"
import type { JobRow } from "./state-types"

const NOW = 10_000_000
const originalXdgDataHome = process.env.XDG_DATA_HOME
const tempDirs: string[] = []

const jobs = [
  {
    title: "Index repository",
    status: "running",
    toolCalls: 2,
    lastTool: "grep",
  },
] as const satisfies readonly JobRow[]

function makeTempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `omo-session-jobs-${label}-`))
  tempDirs.push(dir)
  return dir
}

function hashPathSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

function expectedFilePath(projectDir: string, parentSessionId: string): string {
  return join(
    mirrorStorageDir(),
    "jobs",
    hashPathSegment(canonicalProjectDir(projectDir)),
    `${hashPathSegment(parentSessionId)}.json`,
  )
}

function validPayload(
  projectDir: string,
  parentSessionId: string,
  updatedAt: number = NOW,
): Record<string, unknown> {
  return {
    version: 1,
    projectDir: canonicalProjectDir(projectDir),
    parentSessionId,
    updatedAt,
    jobs,
  }
}

function writeRaw(projectDir: string, parentSessionId: string, raw: unknown): void {
  const filePath = expectedFilePath(projectDir, parentSessionId)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, typeof raw === "string" ? raw : JSON.stringify(raw), "utf-8")
}

describe("session Jobs mirror IPC", () => {
  beforeEach(() => {
    process.env.XDG_DATA_HOME = makeTempDir("xdg")
  })

  afterEach(() => {
    if (originalXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME
    } else {
      process.env.XDG_DATA_HOME = originalXdgDataHome
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("#given two parent sessions in one project #when each writes Jobs #then each exact file round-trips independently", () => {
    // given
    const projectDir = makeTempDir("same-project")

    // when
    writeSessionJobsMirror(projectDir, "session-a", jobs, NOW)
    writeSessionJobsMirror(projectDir, "session-b", [], NOW)

    // then
    expect(expectedFilePath(projectDir, "session-a")).not.toBe(
      expectedFilePath(projectDir, "session-b"),
    )
    expect(readSessionJobsMirror(projectDir, "session-a", NOW)).toEqual(jobs)
    expect(readSessionJobsMirror(projectDir, "session-b", NOW)).toEqual([])
  })

  it("#given two projects with the same parent session #when each writes Jobs #then project hashes isolate their files", () => {
    // given
    const projectA = makeTempDir("project-a")
    const projectB = makeTempDir("project-b")

    // when
    writeSessionJobsMirror(projectA, "shared-session", jobs, NOW)
    writeSessionJobsMirror(projectB, "shared-session", [], NOW)

    // then
    expect(expectedFilePath(projectA, "shared-session")).not.toBe(
      expectedFilePath(projectB, "shared-session"),
    )
    expect(readSessionJobsMirror(projectA, "shared-session", NOW)).toEqual(jobs)
    expect(readSessionJobsMirror(projectB, "shared-session", NOW)).toEqual([])
  })

  it("#given raw path characters in project and session identity #when writing #then only fixed hashes become path segments", () => {
    // given
    const projectDir = join(makeTempDir("raw-project-parent"), "project .. [raw] ü")
    const parentSessionId = "../../parent/session\\..\u0000?"
    mkdirSync(projectDir)
    const filePath = expectedFilePath(projectDir, parentSessionId)

    // when
    writeSessionJobsMirror(projectDir, parentSessionId, jobs, NOW)

    // then
    expect(filePath).toBe(
      join(
        mirrorStorageDir(),
        "jobs",
        hashPathSegment(canonicalProjectDir(projectDir)),
        `${hashPathSegment(parentSessionId)}.json`,
      ),
    )
    expect(basename(dirname(filePath))).toHaveLength(16)
    expect(basename(filePath)).toMatch(/^[a-f0-9]{16}\.json$/)
    expect(JSON.parse(readFileSync(filePath, "utf-8"))).toEqual(validPayload(projectDir, parentSessionId))
  })

  it("#given a Jobs write #when inspecting its file #then the versioned schema has only identity timestamp and display rows", () => {
    // given
    const projectDir = makeTempDir("schema")
    const parentSessionId = "session-schema"

    // when
    writeSessionJobsMirror(projectDir, parentSessionId, jobs, NOW)

    // then
    expect(JSON.parse(readFileSync(expectedFilePath(projectDir, parentSessionId), "utf-8"))).toEqual({
      version: 1,
      projectDir: canonicalProjectDir(projectDir),
      parentSessionId,
      updatedAt: NOW,
      jobs: [
        {
          title: "Index repository",
          status: "running",
          toolCalls: 2,
          lastTool: "grep",
        },
      ],
    })
  })

  it("#given a Jobs write #when inspecting permissions #then the mirror file is mode 0600", () => {
    // given
    const projectDir = makeTempDir("permissions")
    const parentSessionId = "session-private"

    // when
    writeSessionJobsMirror(projectDir, parentSessionId, jobs, NOW)

    // then
    if (process.platform === "win32") {
      return
    }
    expect(statSync(expectedFilePath(projectDir, parentSessionId)).mode & 0o777).toBe(0o600)
  })

  it("#given no exact session file #when reading #then it returns null", () => {
    // given
    const projectDir = makeTempDir("missing")

    // when
    const result = readSessionJobsMirror(projectDir, "missing-session", NOW)

    // then
    expect(result).toBeNull()
  })

  it("#given malformed JSON in the exact session file #when reading #then it returns null", () => {
    // given
    const projectDir = makeTempDir("malformed-json")
    writeRaw(projectDir, "session-json", "{")

    // when
    const result = readSessionJobsMirror(projectDir, "session-json", NOW)

    // then
    expect(result).toBeNull()
  })

  it("#given malformed schema in the exact session file #when reading #then it returns null", () => {
    // given
    const projectDir = makeTempDir("malformed-schema")
    writeRaw(projectDir, "session-schema", {
      ...validPayload(projectDir, "session-schema"),
      jobs: [{ title: "missing display fields" }],
    })

    // when
    const result = readSessionJobsMirror(projectDir, "session-schema", NOW)

    // then
    expect(result).toBeNull()
  })

  it("#given a foreign canonical project in the exact file #when reading #then it returns null", () => {
    // given
    const projectDir = makeTempDir("local-project")
    const foreignProjectDir = makeTempDir("foreign-project")
    writeRaw(projectDir, "session-project", validPayload(foreignProjectDir, "session-project"))

    // when
    const result = readSessionJobsMirror(projectDir, "session-project", NOW)

    // then
    expect(result).toBeNull()
  })

  it("#given a foreign parent session in the exact file #when reading #then it returns null", () => {
    // given
    const projectDir = makeTempDir("foreign-session")
    writeRaw(projectDir, "requested-session", validPayload(projectDir, "foreign-session"))

    // when
    const result = readSessionJobsMirror(projectDir, "requested-session", NOW)

    // then
    expect(result).toBeNull()
  })

  it("#given a stale exact session file #when reading #then it returns null", () => {
    // given
    const projectDir = makeTempDir("stale")
    writeRaw(projectDir, "session-stale", validPayload(projectDir, "session-stale", NOW - STALE_MS - 1))

    // when
    const result = readSessionJobsMirror(projectDir, "session-stale", NOW)

    // then
    expect(result).toBeNull()
  })

  it("#given a valid requested file and malformed sibling file #when reading each #then sibling content cannot interfere", () => {
    // given
    const projectDir = makeTempDir("non-interference")
    writeSessionJobsMirror(projectDir, "requested-session", jobs, NOW)
    writeRaw(projectDir, "sibling-session", "{")

    // when
    const requested = readSessionJobsMirror(projectDir, "requested-session", NOW)
    const sibling = readSessionJobsMirror(projectDir, "sibling-session", NOW)

    // then
    expect(requested).toEqual(jobs)
    expect(sibling).toBeNull()
  })

  it("#given a symlink at the exact output file #when writing #then atomic replacement does not modify the symlink target", () => {
    // given
    const projectDir = makeTempDir("file-symlink-project")
    const parentSessionId = "session-file-symlink"
    const filePath = expectedFilePath(projectDir, parentSessionId)
    const victimPath = join(makeTempDir("file-symlink-victim"), "victim.json")
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(victimPath, "untouched", "utf-8")
    symlinkSync(victimPath, filePath, "file")

    // when
    writeSessionJobsMirror(projectDir, parentSessionId, jobs, NOW)

    // then
    expect(readFileSync(victimPath, "utf-8")).toBe("untouched")
    expect(lstatSync(filePath).isSymbolicLink()).toBe(false)
    expect(readSessionJobsMirror(projectDir, parentSessionId, NOW)).toEqual(jobs)
  })

  it("#given a symlinked project-hash directory #when writing #then it rejects the redirected parent", () => {
    // given
    const projectDir = makeTempDir("directory-symlink-project")
    const parentSessionId = "session-directory-symlink"
    const filePath = expectedFilePath(projectDir, parentSessionId)
    const outsideDir = makeTempDir("directory-symlink-outside")
    mkdirSync(dirname(dirname(filePath)), { recursive: true })
    symlinkSync(outsideDir, dirname(filePath), "dir")

    // when
    const write = (): void => writeSessionJobsMirror(projectDir, parentSessionId, jobs, NOW)

    // then
    expect(write).toThrow()
    expect(existsSync(join(outsideDir, basename(filePath)))).toBe(false)
  })

  it("#given a symlinked jobs directory #when writing #then it does not create the project hash outside", () => {
    // given
    const projectDir = makeTempDir("jobs-symlink-project")
    const parentSessionId = "session-jobs-symlink"
    const filePath = expectedFilePath(projectDir, parentSessionId)
    const jobsPath = dirname(dirname(filePath))
    const outsideDir = makeTempDir("jobs-symlink-outside")
    const outsideProjectPath = join(outsideDir, basename(dirname(filePath)))
    mkdirSync(dirname(jobsPath), { recursive: true })
    symlinkSync(outsideDir, jobsPath, "dir")
    expect(existsSync(outsideProjectPath)).toBe(false)

    // when
    const write = (): void => writeSessionJobsMirror(projectDir, parentSessionId, jobs, NOW)

    // then
    expect(write).toThrow()
    expect(existsSync(outsideProjectPath)).toBe(false)
  })

  it("#given a symlinked exact input file #when reading #then it returns null without following the link", () => {
    // given
    const projectDir = makeTempDir("read-symlink-project")
    const parentSessionId = "session-read-symlink"
    const filePath = expectedFilePath(projectDir, parentSessionId)
    const outsidePath = join(makeTempDir("read-symlink-outside"), "outside.json")
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(outsidePath, JSON.stringify(validPayload(projectDir, parentSessionId)), "utf-8")
    symlinkSync(outsidePath, filePath, "file")

    // when
    const result = readSessionJobsMirror(projectDir, parentSessionId, NOW)

    // then
    expect(result).toBeNull()
  })
})
