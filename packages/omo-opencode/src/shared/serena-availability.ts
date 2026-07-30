import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { getSystemMcpServerNames } from "../features/claude-code-mcp-loader"

function isOpencodeSerenaAvailable(): boolean {
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  const candidates = [
    join(process.cwd(), "opencode.json"),
    join(process.cwd(), "opencode.jsonc"),
    join(process.cwd(), ".opencode", "opencode.json"),
    join(process.cwd(), ".opencode", "opencode.jsonc"),
    join(xdgConfig, "opencode", "opencode.json"),
    join(xdgConfig, "opencode", "opencode.jsonc"),
    join(xdgConfig, "opencode", "config.json"),
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const config = JSON.parse(readFileSync(candidate, "utf-8")) as Record<string, unknown>
      const mcp = config.mcp as Record<string, unknown> | undefined
      if (mcp && Object.keys(mcp).some((key) => key.toLowerCase().includes("serena"))) return true
    } catch {
      continue
    }
  }
  return false
}

export function isSerenaServerAvailable(): boolean {
  return (
    Array.from(getSystemMcpServerNames()).some((name) => name.toLowerCase().includes("serena")) ||
    isOpencodeSerenaAvailable()
  )
}
