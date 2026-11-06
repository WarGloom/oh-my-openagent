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

type V2RpcDefinition = {
  readonly id: string
  readonly methods: Readonly<Record<string, { readonly input: z.ZodType; readonly output: z.ZodType }>>
  readonly events: Readonly<Record<string, { readonly schema: z.ZodType }>>
}
export type V2RpcHandlers<D extends V2RpcDefinition> = {
  readonly [Name in keyof D["methods"]]: (
    input: z.output<D["methods"][Name]["input"]>,
  ) => Promise<z.input<D["methods"][Name]["output"]>>
}
export type V2RpcRegistration<D extends V2RpcDefinition> = V2Registration & {
  readonly events: {
    readonly emit: (
      ...args: {
        [Name in keyof D["events"] & string]: [name: Name, data: z.input<D["events"][Name]["schema"]>]
      }[keyof D["events"] & string]
    ) => Promise<void>
  }
}
export type V2ToastRpc = {
  readonly register: <const D extends V2RpcDefinition>(
    definition: D,
    handlers: V2RpcHandlers<NoInfer<D>>,
  ) => Promise<V2RpcRegistration<D>>
}
