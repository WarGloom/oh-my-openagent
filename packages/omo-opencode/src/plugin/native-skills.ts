import { OpencodeClient as V2OpencodeClient } from "@opencode-ai/sdk/v2"
import type { Client as V2GeneratedClient } from "@opencode-ai/sdk/v2/gen/client"
import { z } from "zod"
import { log } from "../shared"
import type { SkillLoadOptions } from "../tools/skill/types"
import type { PluginContext } from "./types"
import { getNativeSkillState } from "../v2/native-skill-state"
import type { LoadedSkill } from "../features/opencode-skill-loader"
import { mergeNativeSkills } from "../tools/skill/native-skills"
import { loadSkillFromPath } from "@oh-my-opencode/skills-loader-core/opencode-skill-loader/loaded-skill-from-path"
import { dirname } from "node:path"
import { NativeSkillError } from "../v2/native-skill-expansion"
import { existsSync } from "node:fs"

const NativeSkillEntrySchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  location: z.string(),
  content: z.string(),
})
const NativeSkillEntriesSchema = z.array(NativeSkillEntrySchema)

type NativeSkills = NonNullable<SkillLoadOptions["nativeSkills"]>

export function createNativeLoadedSkillsResolver(options: {
  readonly skills: ReadonlyArray<LoadedSkill>
  readonly nativeSkills: NativeSkills
  readonly directory: string
  readonly disabledSkills: ReadonlySet<string>
}): () => Promise<LoadedSkill[]> {
  return async () => {
    const skills = [...options.skills]
    const native = await options.nativeSkills.all()
    mergeNativeSkills(skills, native, options.disabledSkills, options.directory)
    return Promise.all(skills.map(async (skill) => {
      if (options.skills.includes(skill) || !skill.path || skill.path.startsWith("skill://") || !existsSync(skill.path)) return skill
      const metadata = await loadSkillFromPath({
        skillPath: skill.path, resolvedPath: dirname(skill.path), defaultName: skill.name, scope: skill.scope, provenance: skill.provenance,
      })
      if (!metadata) throw new NativeSkillError(skill.name, `Native skill metadata could not be loaded from ${skill.path}`)
      return {
        ...metadata,
        name: skill.name,
        definition: { ...metadata.definition, name: skill.name, description: skill.definition.description, template: native.find((entry) => entry.name === skill.name)?.content ?? skill.definition.template },
        lazyContent: skill.lazyContent,
      }
    }))
  }
}

function getObjectProperty(value: unknown, property: string): unknown {
  if (typeof value !== "object" || value === null) return undefined
  return Reflect.get(value, property)
}

function isNativeSkills(value: unknown): value is NativeSkills {
  return (
    typeof getObjectProperty(value, "all") === "function" &&
    typeof getObjectProperty(value, "get") === "function" &&
    typeof getObjectProperty(value, "dirs") === "function"
  )
}

function isV2GeneratedClient(value: unknown): value is V2GeneratedClient {
  return typeof getObjectProperty(value, "get") === "function"
}

function getGeneratedClientFromPluginClient(client: PluginContext["client"]): unknown {
  return getObjectProperty(client, "_client")
}

export function getPluginInputNativeSkills(ctx: PluginContext): NativeSkills | undefined {
  const state = getNativeSkillState(ctx)
  if (state) {
    const all = async () => (await state.context.skill.list()).data.map((skill) => ({
      name: skill.name,
      description: skill.description ?? "",
      location: skill.path,
      content: skill.content,
    }))
    return { all, get: async (name) => (await all()).find((skill) => skill.name === name), dirs: () => [] }
  }
  const value = getObjectProperty(ctx, "skills")
  return isNativeSkills(value) ? value : undefined
}

export function createNativeSkills(input: { readonly client: PluginContext["client"]; readonly directory: string }): NativeSkills {
  const load = async () => {
    const generatedClient = getGeneratedClientFromPluginClient(input.client)
    if (!isV2GeneratedClient(generatedClient)) {
      log("[native-skills] v2 sdk nativeSkills unavailable", {
        hasGeneratedClient: generatedClient !== undefined,
      })
      return []
    }

    try {
      const client = new V2OpencodeClient({ client: generatedClient })
      const result = await client.app.skills({ directory: input.directory }, { throwOnError: true })
      const parsed = NativeSkillEntriesSchema.safeParse(getObjectProperty(result, "data"))
      if (!parsed.success) {
        log("[native-skills] v2 sdk nativeSkills parse failed", { error: parsed.error.message })
      }
      return parsed.success ? parsed.data : []
    } catch (error) {
      log("[native-skills] v2 sdk nativeSkills load failed", {
        error: error instanceof Error ? error.message : String(error),
      })
      return []
    }
  }

  return {
    all: load,
    async get(name) {
      return (await load()).find((skill) => skill.name === name)
    },
    dirs() {
      return []
    },
  }
}
