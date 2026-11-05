import type { PluginInput } from "@opencode-ai/plugin"
import type { V2PluginContext } from "../context-types"
import { createAppNamespace } from "./app-namespace"
import { createConfigNamespace } from "./config-namespace"
import { withFallback } from "./fallback"
import { createProviderNamespace, toV1Model } from "./provider-namespace"
import { createSessionNamespace, type SessionNamespaceDeps } from "./session-namespace"
import { bindTodoWriter } from "../session-todos"
import type { V2ToastEmitter } from "../toast-channel"
import { settle, type V1Result } from "./v1-result"
import { bindNativeSdkStorage } from "../../shared/opencode-storage-detection"
import { bindNativeFormatter } from "../native-formatter"

type V1Client = PluginInput["client"]
type FacadeClient = V1Client & { readonly model: { readonly list: () => Promise<V1Result<Array<ReturnType<typeof toV1Model> & { provider: string }>>> } }

export type ClientFacadeDeps = SessionNamespaceDeps & { readonly emitToast?: V2ToastEmitter }

/**
 * The V1 SDK client shape the plugin body is written against, backed by the 2.x context. Mapped
 * methods return the 1.x response shape; every method not mapped yet rejects with the exact
 * operation name (see fallback.ts).
 */
export function createClientFacade(context: V2PluginContext, deps: ClientFacadeDeps): FacadeClient {
  const client = withFallback(["client"], {
    provider: withFallback(["client", "provider"], createProviderNamespace(context)),
    model: withFallback(["client", "model"], {
      list: () => settle(async () => (await context.model.list()).data.map((model) => ({ ...toV1Model(model), provider: model.providerID }))),
    }),
    config: withFallback(["client", "config"], createConfigNamespace(context)),
    app: withFallback(["client", "app"], createAppNamespace(context)),
    session: withFallback(["client", "session"], createSessionNamespace(context, deps)),
    tui: withFallback(["client", "tui"], {
      showToast: async (options: Parameters<V1Client["tui"]["showToast"]>[0]) => {
        if (options?.body) {
          const { title, message, variant, duration } = options.body
          await deps.emitToast?.({ message, variant, ...(title === undefined ? {} : { title }), ...(duration === undefined ? {} : { duration }) })
        }
        return { data: true }
      },
    }),
  }) as unknown as FacadeClient
  bindTodoWriter(client, context)
  bindNativeSdkStorage(client)
  bindNativeFormatter(client, context)
  return client
}
