export type SessionModel = { readonly providerID: string; readonly modelID: string }
export type SessionModelWithVariant = SessionModel & { readonly variant?: string }
export type StoredSessionModel = SessionModelWithVariant & { readonly agent?: string }

const sessionModels = new Map<string, StoredSessionModel>()

export function setSessionModel(sessionID: string, model: SessionModelWithVariant, agent?: string): void {
  const normalizedAgent = agent?.trim()
  const normalizedVariant = model.variant?.trim()
  sessionModels.set(sessionID, {
    providerID: model.providerID,
    modelID: model.modelID,
    ...(normalizedVariant ? { variant: normalizedVariant } : {}),
    ...(normalizedAgent ? { agent: normalizedAgent } : {}),
  })
}

export function getSessionModel(sessionID: string): SessionModel | undefined {
  const storedModel = sessionModels.get(sessionID)
  if (!storedModel) return undefined

  return {
    providerID: storedModel.providerID,
    modelID: storedModel.modelID,
  }
}

export function getStoredSessionModel(sessionID: string): StoredSessionModel | undefined {
  const storedModel = sessionModels.get(sessionID)
  if (!storedModel) return undefined

  return {
    providerID: storedModel.providerID,
    modelID: storedModel.modelID,
    ...(storedModel.variant ? { variant: storedModel.variant } : {}),
    ...(storedModel.agent ? { agent: storedModel.agent } : {}),
  }
}

export function clearSessionModel(sessionID: string): void {
  sessionModels.delete(sessionID)
}
