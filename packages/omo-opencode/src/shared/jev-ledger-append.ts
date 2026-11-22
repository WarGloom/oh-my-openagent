import { constants } from "node:fs"
import { mkdir, open, readdir } from "node:fs/promises"
import { join } from "node:path"
import { withLock } from "@oh-my-opencode/team-core/team-state-store/locks"

export async function appendJevLedger(directory: string, stem: string, bytes: Buffer): Promise<void> {
  const maxBytes = 50 * 1024 * 1024
  if (bytes.length > maxBytes) throw new RangeError("Ledger batch exceeds part size")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await withLock(join(directory, ".append.lock"), async () => {
    const parts = (await readdir(directory)).flatMap((name) => {
      const match = new RegExp(`^${stem}(?:\\.(\\d+))?\\.jsonl$`).exec(name)
      return match ? [Number(match[1] ?? 0)] : []
    })
    let part = Math.max(0, ...parts)
    while (true) {
      const path = join(directory, `${stem}${part ? `.${part}` : ""}.jsonl`)
      const file = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        await file.chmod(0o600)
        if ((await file.stat()).size + bytes.length > maxBytes) {
          part++
          continue
        }
        if ((await file.write(bytes)).bytesWritten !== bytes.length) throw new RangeError("Incomplete ledger append")
        await file.sync()
        return
      } finally {
        await file.close()
      }
    }
  })
}
