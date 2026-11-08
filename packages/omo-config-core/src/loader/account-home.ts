import { readFileSync } from "node:fs"
import { homedir, userInfo } from "node:os"

export function parsePasswdHome(passwd: string, uid: number): string | undefined {
  for (const line of passwd.split(/\r?\n/)) {
    const fields = line.split(":")
    if (fields.length >= 7 && fields[2] === String(uid) && fields[5]) return fields[5]
  }
  return undefined
}

export function selectAccountHome(options: {
  readonly readPasswd: () => string
  readonly getuid: (() => number) | undefined
  readonly platform: NodeJS.Platform
  readonly fallbackHome: () => string
}): string {
  try {
    if (options.platform !== "win32" && options.getuid !== undefined) {
      const home = parsePasswdHome(options.readPasswd(), options.getuid())
      if (home !== undefined) return home
    }
  } catch {
    // Fall back when the passwd database cannot be read.
  }
  return options.fallbackHome()
}

function readAccountHome(): string {
  try {
    return userInfo().homedir
  } catch {
    try {
      return homedir()
    } catch {
      return process.env.HOME ?? process.env.USERPROFILE ?? "."
    }
  }
}

const ACCOUNT_HOME = selectAccountHome({
  readPasswd: () => readFileSync("/etc/passwd", "utf8"),
  getuid: process.getuid,
  platform: process.platform,
  fallbackHome: readAccountHome,
})

export function resolveAccountHomeDir(): string {
  return ACCOUNT_HOME
}
