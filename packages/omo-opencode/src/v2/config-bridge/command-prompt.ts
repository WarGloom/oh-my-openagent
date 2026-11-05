import type { V2CommandInvocation, V2PromptInput } from "../context-types"
import type { CommandPart } from "./create-command-executor"
import { z } from "zod"

const mentionSchema = z.object({ start: z.number(), end: z.number(), text: z.string() })
const fileSchema = z
  .object({
    uri: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    mention: mentionSchema.optional(),
    source: z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("inline") }),
        z.object({ type: z.literal("uri"), uri: z.string() }),
      ])
      .optional(),
  })
  .passthrough()

type CommandPrompt = V2CommandInvocation["prompt"] & { readonly metadata?: V2PromptInput["metadata"] }

export function commandPromptParts(prompt: CommandPrompt): CommandPart[] {
  return [
    { type: "text", text: prompt.text },
    ...(prompt.files ?? []).map((file) => ({
      ...file,
      type: "file",
      url: file.uri,
      ...(file.name ? { filename: file.name } : {}),
    })),
  ]
}

export function buildCommandPrompt(
  prompt: CommandPrompt,
  parts: ReadonlyArray<CommandPart>,
): CommandPrompt | undefined {
  const textParts = parts.flatMap((part) =>
    part.type === "text" && typeof part.text === "string"
      ? [{ type: "text" as const, text: part.text, ...(part.synthetic === true ? { synthetic: true } : {}) }]
      : [],
  )
  const files = parts.flatMap((part) => {
    if (part.type !== "file" || typeof part.url !== "string") return []
    const { type, url, filename, ...attributes } = part
    return [fileSchema.parse({ ...attributes, uri: url, ...(typeof filename === "string" ? { name: filename } : {}) })]
  })
  if (!textParts.length && !files.length) return undefined
  return {
    ...prompt,
    text: textParts.map((part) => part.text).join("\n"),
    ...(files.length || prompt.files ? { files } : {}),
    ...(prompt.metadata || textParts.some((part) => part.synthetic)
      ? {
          metadata: {
            ...prompt.metadata,
            ...(textParts.some((part) => part.synthetic) ? { omoCommandParts: textParts } : {}),
          },
        }
      : {}),
  }
}
