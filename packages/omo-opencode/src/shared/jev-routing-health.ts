import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { withLock } from "@oh-my-opencode/team-core/team-state-store/locks"
import { getPostHogActivityStateDir } from "./posthog-activity-state"
import { log } from "./logger"

const HealthSchema = z
  .object({
    ledger_write_failures: z.number().int().nonnegative(),
    model_mismatches: z.number().int().nonnegative(),
    unknown_artifacts: z.number().int().nonnegative(),
  })
  .strict()
type Health = z.infer<typeof HealthSchema>
type Counter = keyof Health
const pending = new Map<string, Health>()
const empty = (): Health => ({ ledger_write_failures: 0, model_mismatches: 0, unknown_artifacts: 0 })

export function getJevRoutingStateDirectory(): string {
  return join(getPostHogActivityStateDir(), "jev-routing")
}

async function stored(directory: string): Promise<Health> {
  try {
    return HealthSchema.parse(JSON.parse(await readFile(join(directory, "health.json"), "utf8")))
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return empty()
  }
}

export async function readJevRoutingHealth(): Promise<Health> {
  const directory = getJevRoutingStateDirectory()
  const disk = await stored(directory)
  const local = pending.get(directory) ?? empty()
  return {
    ledger_write_failures: disk.ledger_write_failures + local.ledger_write_failures,
    model_mismatches: disk.model_mismatches + local.model_mismatches,
    unknown_artifacts: disk.unknown_artifacts + local.unknown_artifacts,
  }
}

export function warnJevRouting(counter: Counter): Promise<void> {
  log("[jev-routing] routing warning", {
    severity: counter === "unknown_artifacts" ? "error" : "warning",
    reason: counter,
  })
  const directory = getJevRoutingStateDirectory()
  const local = pending.get(directory) ?? empty()
  local[counter]++
  pending.set(directory, local)
  return (async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await withLock(join(directory, ".health.lock"), async () => {
      const disk = await stored(directory)
      disk[counter]++
      const temporary = join(directory, `.health-${randomUUID()}.json`)
      await writeFile(temporary, JSON.stringify(disk), { flag: "wx", mode: 0o600 })
      await rename(temporary, join(directory, "health.json"))
      local[counter]--
    })
  })().catch((error: unknown) => {
    log("[jev-routing] health persistence failed", { error: error instanceof Error ? error.name : "unknown" })
  })
}
