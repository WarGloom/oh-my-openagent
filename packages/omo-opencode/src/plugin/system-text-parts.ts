export type SystemTextParts = {
  readonly read: () => string[]
  readonly write?: (texts: string[]) => void
}

export async function reconcileSystemTextParts(
  parts: SystemTextParts,
  transform: (texts: string[]) => Promise<void>,
): Promise<void> {
  const texts = parts.read()
  await transform(texts)
  parts.write?.(texts)
}
