import { existsSync, watch, type FSWatcher } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { userInfo } from "node:os"
import {
  MAX_PROJECT_CONFIG_DIRECTORY_DEPTH,
  resolveHomeDir,
  resolveUserOmoConfigDirectory,
} from "@oh-my-opencode/omo-config-core"

function watchDirectories(directory: string): Set<string> {
  const home = resolveHomeDir()
  const accountHome = userInfo().homedir
  const candidates = [resolveUserOmoConfigDirectory()]
  let current = resolve(directory)
  for (
    let depth = 0;
    depth < MAX_PROJECT_CONFIG_DIRECTORY_DEPTH && current !== home && current !== accountHome;
    depth += 1
  ) {
    candidates.push(join(current, ".omo"))
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return new Set(
    candidates.map((candidate) => {
      let existing = candidate
      while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing)
      return existing
    }),
  )
}

export function watchModelConfigFiles(input: {
  readonly directory: string
  readonly notify: () => void
  readonly report: (message: string) => void
}): () => void {
  const watchers = new Map<string, FSWatcher>()
  let active = true
  const synchronize = (): void => {
    if (!active) return
    const directories = watchDirectories(input.directory)
    for (const [directory, watcher] of watchers) {
      if (directories.has(directory)) continue
      watcher.close()
      watchers.delete(directory)
    }
    for (const directory of directories) {
      if (watchers.has(directory)) continue
      try {
        const watcher = watch(directory, { persistent: false }, (_event, filename) => {
          if (
            !active ||
            (filename !== null && filename !== "omo.jsonc" && filename !== "omo.json" && filename !== ".omo")
          )
            return
          synchronize()
          input.notify()
        })
        watchers.set(directory, watcher)
        watcher.on("error", (error) => {
          watcher.close()
          watchers.delete(directory)
          input.report(`Model config watcher failed for ${directory}: ${error.message}`)
          synchronize()
        })
      } catch (error) {
        if (!(error instanceof Error)) throw error
        input.report(`Model config watcher unavailable for ${directory}: ${error.message}`)
      }
    }
  }
  synchronize()
  return () => {
    active = false
    for (const watcher of watchers.values()) watcher.close()
    watchers.clear()
  }
}
