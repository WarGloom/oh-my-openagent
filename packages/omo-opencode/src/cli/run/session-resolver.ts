import pc from "picocolors"
import { PUBLISHED_PACKAGE_NAME } from "../../shared"
import type { OpencodeClient } from "./types"
import { serializeError } from "./events"
import { logRunTrace } from "./run-debug"

const SESSION_CREATE_MAX_RETRIES = 3
const SESSION_CREATE_RETRY_DELAY_MS = 1000

export async function resolveSession(options: {
  client: OpencodeClient
  sessionId?: string
  directory: string
  retryDelayMs?: number
}): Promise<string> {
  const { client, sessionId, directory } = options
  const retryDelayMs = options.retryDelayMs ?? SESSION_CREATE_RETRY_DELAY_MS

  if (sessionId) {
    logRunTrace(`resolving explicit session ${sessionId}`)
    const res = await client.session.get({
      path: { id: sessionId },
      query: { directory },
    })
    if (res.error || !res.data) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    logRunTrace(`resolved explicit session ${sessionId}`)
    return sessionId
  }

  for (let attempt = 1; attempt <= SESSION_CREATE_MAX_RETRIES; attempt++) {
    logRunTrace(`creating session attempt ${attempt}/${SESSION_CREATE_MAX_RETRIES}`)
    const res = await client.session.create({
      body: {
        title: `${PUBLISHED_PACKAGE_NAME} run`,
        permission: [
          { permission: "question", action: "deny" as const, pattern: "*" },
        ],
      } as Record<string, unknown>,
      query: { directory },
    })

    if (res.error) {
      console.error(
        pc.yellow(`Session create attempt ${attempt}/${SESSION_CREATE_MAX_RETRIES} failed:`)
      )
      console.error(pc.dim(`  Error: ${serializeError(res.error)}`))

      if (attempt < SESSION_CREATE_MAX_RETRIES) {
        const delay = retryDelayMs * attempt
        console.log(pc.dim(`  Retrying in ${delay}ms...`))
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
      continue
    }

    if (res.data?.id) {
      logRunTrace(`created session ${res.data.id} on attempt ${attempt}`)
      return res.data.id
    }

    console.error(
      pc.yellow(
        `Session create attempt ${attempt}/${SESSION_CREATE_MAX_RETRIES}: No session ID returned`
      )
    )

    if (attempt < SESSION_CREATE_MAX_RETRIES) {
      const delay = retryDelayMs * attempt
      console.log(pc.dim(`  Retrying in ${delay}ms...`))
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  logRunTrace("session creation failed after all retries")
  throw new Error("Failed to create session after all retries")
}
