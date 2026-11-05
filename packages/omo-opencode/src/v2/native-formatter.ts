import type { V2PluginContext } from "./context-types"

const formatters = new WeakMap<object, V2PluginContext["experimental"]["formatter"]["file"]>()

export function bindNativeFormatter(client: object, context: V2PluginContext): void {
  formatters.set(client, (input) => context.experimental.formatter.file(input))
}

export function getNativeFormatter(client: object) {
  return formatters.get(client)
}
