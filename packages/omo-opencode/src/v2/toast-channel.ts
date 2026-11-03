import { z } from "zod"
import type { V2Registration } from "./context-types"

export const toastSchema = z.object({
  title: z.string().optional(),
  message: z.string(),
  variant: z.enum(["info", "success", "warning", "error"]),
  duration: z.number().optional(),
})

export type V2Toast = z.infer<typeof toastSchema>
export type V2ToastEmitter = (toast: V2Toast) => Promise<void>

export const toastChannel = {
  id: "omo",
  methods: {},
  events: { toast: { schema: toastSchema } },
} as const

export type V2ToastRegistration = V2Registration & {
  readonly events: { readonly emit: (name: "toast", toast: V2Toast) => Promise<void> }
}

export type V2ToastRpc = {
  readonly register: (
    definition: typeof toastChannel,
    handlers: Readonly<Record<string, never>>,
  ) => Promise<V2ToastRegistration>
}
