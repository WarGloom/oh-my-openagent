import {
  selectFallbackProviderWithCache,
} from "@oh-my-opencode/model-core"
import * as connectedProvidersCache from "./connected-providers-cache"

export type { ErrorInfo } from "@oh-my-opencode/model-core"
export {
  isRetryableModelError,
  shouldRetryError,
  getRuntimeFallbackStatusCode,
  getRuntimeFallbackRetryableSignal,
  getNextFallback,
  hasMoreFallbacks,
  selectFallbackProviderWithCache,
} from "@oh-my-opencode/model-core"

export function selectFallbackProvider(
  providers: string[],
  preferredProviderID?: string,
): string {
  return selectFallbackProviderWithCache(
    providers,
    connectedProvidersCache,
    preferredProviderID,
  )
}
