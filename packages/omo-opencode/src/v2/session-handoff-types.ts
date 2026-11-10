import { z } from "zod"

export const HandoffInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), query: z.string().max(200).optional() }).strict(),
  z
    .object({
      action: z.literal("send"),
      sessionID: z.string().regex(/^ses_[A-Za-z0-9_]+$/),
      text: z.string().min(1).max(16_384),
    })
    .strict(),
])

export const SessionIdentity = z.object({
  id: z.string(),
  projectID: z.string(),
  title: z.string().optional(),
  agent: z.string().optional(),
  parentID: z.string().optional(),
  location: z.object({ directory: z.string(), workspaceID: z.string().optional() }),
  time: z.object({ created: z.number(), updated: z.number(), archived: z.number().optional() }),
})

export type HandoffBinding = {
  readonly sender: {
    readonly sessionID: string
    readonly agent: string
    readonly messageID: string
    readonly callID: string
  }
  readonly target: {
    readonly sessionID: string
    readonly projectID: string
    readonly location: z.infer<typeof SessionIdentity>["location"]
    readonly agent?: string
  }
  readonly text: string
}

export type NativeHandoffReceipt = {
  readonly id: string
  readonly sessionID: string
  readonly status: "approval-required" | "admitted" | "delivered"
  readonly duplicate: boolean
  readonly wakeScheduled: boolean
}

export type NativeSessionHandoff = (
  input: HandoffBinding & { readonly commit: boolean },
) => Promise<NativeHandoffReceipt>

export class HandoffError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = "HandoffError"
  }
}
