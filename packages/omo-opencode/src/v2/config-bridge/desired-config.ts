import type { V2McpServerConfig, V2PermissionRule } from "../context-types"
import type { CommandSpec } from "./create-command-executor"
import { migrateMcpConfig } from "./migrate-mcp"
import { migrateAgentConfig, migratePermissionConfig, type V2AgentPatch } from "./migrate-agent"

export type DesiredModel = {
  readonly reasoning?: boolean
  readonly name?: string
  readonly tools?: boolean
  readonly input?: ReadonlyArray<string>
  readonly output?: ReadonlyArray<string>
  readonly limit?: { readonly context?: number; readonly output?: number }
  readonly cost?: {
    readonly input: number
    readonly output: number
    readonly cache: { readonly read: number; readonly write: number }
  }
}

/** A 1.x `config.provider` entry the hook added, in 2.x terms. */
export type DesiredProvider = {
  readonly name?: string
  readonly package?: string
  /** 1.x `options` without `headers`: `baseURL` and the provider package options. */
  readonly settings?: Readonly<Record<string, unknown>>
  readonly headers?: Readonly<Record<string, string>>
  readonly env: ReadonlyArray<string>
  readonly models: ReadonlyArray<readonly [string, DesiredModel]>
}

/**
 * Provider and model ids the snapshot carried in from host state. The hook output repeats them, but
 * they are the host's own definitions, so they are not desired registrations.
 */
export type ProviderBaseline = ReadonlyMap<string, ReadonlySet<string>>

/** What the 1.x config hook asked for, in 2.x terms. Plain data, so two results compare by JSON. */
export type DesiredConfig = {
  readonly agents: ReadonlyArray<readonly [string, V2AgentPatch]>
  readonly globalPermissions: ReadonlyArray<V2PermissionRule>
  readonly mcp: ReadonlyArray<readonly [string, V2McpServerConfig]>
  /** MCP entries 2.x cannot represent; the bridge warns about them. */
  readonly skippedMcp: ReadonlyArray<string>
  readonly commands: ReadonlyArray<readonly [string, CommandSpec]>
  /** Command entries without a usable template; the bridge warns about them. */
  readonly skippedCommands: ReadonlyArray<string>
  readonly providers: ReadonlyArray<readonly [string, DesiredProvider]>
  readonly defaultAgent?: string
}

export const EMPTY_DESIRED_CONFIG: DesiredConfig = {
  agents: [],
  globalPermissions: [],
  mcp: [],
  skippedMcp: [],
  commands: [],
  skippedCommands: [],
  providers: [],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function strings(value: unknown): ReadonlyArray<string> | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function readModel(entry: Record<string, unknown>): DesiredModel {
  const modalities = isRecord(entry.modalities) ? entry.modalities : {}
  const input = strings(modalities.input)
  const output = strings(modalities.output)
  const limit = isRecord(entry.limit) ? entry.limit : undefined
  const context = finite(limit?.context)
  const outputLimit = finite(limit?.output)
  const cost = isRecord(entry.cost) ? entry.cost : undefined
  const costInput = finite(cost?.input)
  const costOutput = finite(cost?.output)
  return {
    ...(typeof entry.reasoning === "boolean" ? { reasoning: entry.reasoning } : {}),
    ...(typeof entry.name === "string" ? { name: entry.name } : {}),
    ...(typeof entry.tool_call === "boolean" ? { tools: entry.tool_call } : {}),
    ...(input ? { input } : {}),
    ...(output ? { output } : {}),
    ...(context !== undefined || outputLimit !== undefined
      ? {
          limit: {
            ...(context !== undefined ? { context } : {}),
            ...(outputLimit !== undefined ? { output: outputLimit } : {}),
          },
        }
      : {}),
    ...(costInput !== undefined && costOutput !== undefined
      ? {
          cost: {
            input: costInput,
            output: costOutput,
            cache: { read: finite(cost?.cache_read) ?? 0, write: finite(cost?.cache_write) ?? 0 },
          },
        }
      : {}),
  }
}

function readProviders(value: unknown, baseline: ProviderBaseline): Array<readonly [string, DesiredProvider]> {
  if (!isRecord(value)) return []
  return Object.entries(value).flatMap(([id, entry]): Array<readonly [string, DesiredProvider]> => {
    if (!isRecord(entry)) return []
    const known = baseline.get(id)
    const models = (isRecord(entry.models) ? Object.entries(entry.models) : []).flatMap(
      ([modelID, model]): Array<readonly [string, DesiredModel]> =>
        isRecord(model) && !known?.has(modelID) ? [[modelID, readModel(model)]] : [],
    )
    if (known && models.length === 0) return []
    const options = isRecord(entry.options) ? entry.options : {}
    const { headers, ...settings } = options
    const headerEntries = isRecord(headers)
      ? Object.entries(headers).filter((pair): pair is [string, string] => typeof pair[1] === "string")
      : []
    return [
      [
        id,
        {
          ...(typeof entry.name === "string" ? { name: entry.name } : {}),
          ...(typeof entry.npm === "string" ? { package: entry.npm } : {}),
          ...(Object.keys(settings).length > 0 ? { settings } : {}),
          ...(headerEntries.length > 0 ? { headers: Object.fromEntries(headerEntries) } : {}),
          env: strings(entry.env) ?? [],
          models,
        },
      ],
    ]
  })
}

export function readDesiredConfig(
  config: Readonly<Record<string, unknown>>,
  providerBaseline: ProviderBaseline = new Map(),
): DesiredConfig {
  const agents = isRecord(config.agent)
    ? Object.entries(config.agent).flatMap(([id, entry]): Array<readonly [string, V2AgentPatch]> =>
        isRecord(entry) ? [[id, migrateAgentConfig(entry)]] : [],
      )
    : []
  const mcp: Array<readonly [string, V2McpServerConfig]> = []
  const skippedMcp: string[] = []
  if (isRecord(config.mcp)) {
    for (const [name, entry] of Object.entries(config.mcp)) {
      const migrated = migrateMcpConfig(entry)
      if (migrated === undefined) skippedMcp.push(name)
      else mcp.push([name, migrated])
    }
  }
  const commands: Array<readonly [string, CommandSpec]> = []
  const skippedCommands: string[] = []
  if (isRecord(config.command)) {
    for (const [name, entry] of Object.entries(config.command)) {
      if (!isRecord(entry) || typeof entry.template !== "string") {
        skippedCommands.push(name)
        continue
      }
      commands.push([
        name,
        {
          template: entry.template,
          ...(typeof entry.description === "string" ? { description: entry.description } : {}),
          ...(typeof entry.agent === "string" ? { agent: entry.agent } : {}),
          ...(typeof entry.model === "string" ? { model: entry.model } : {}),
          ...(typeof entry.subtask === "boolean" ? { subtask: entry.subtask } : {}),
        },
      ])
    }
  }
  return {
    agents,
    globalPermissions: migratePermissionConfig(config.tools, config.permission),
    mcp,
    skippedMcp,
    commands,
    skippedCommands,
    providers: readProviders(config.provider, providerBaseline),
    ...(typeof config.default_agent === "string" ? { defaultAgent: config.default_agent } : {}),
  }
}
