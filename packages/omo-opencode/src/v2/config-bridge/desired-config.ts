import type { V2McpServerConfig, V2ModelInfo, V2ModelRef, V2PermissionRule } from "../context-types"
import type { CommandSpec } from "./create-command-executor"
import { migrateMcpConfig } from "./migrate-mcp"
import { migrateAgentConfig, migratePermissionConfig, type V2AgentPatch } from "./migrate-agent"
import type { OhMyOpenCodeConfig } from "../../config"
import type { Hooks } from "@opencode-ai/plugin"
import { lowerReasoningForModel } from "../../shared/agent-variant"
import { parseModelString } from "../../shared/model-string-parser"
import { transformModelForProvider } from "../../shared/provider-model-id-transform"

const agentModelOverrides = new WeakMap<Hooks, NonNullable<OhMyOpenCodeConfig["agents"]>>()

export function bindAgentModelOverrides(hooks: Hooks, agents: OhMyOpenCodeConfig["agents"]): void {
  if (agents) agentModelOverrides.set(hooks, agents)
}

/** What the 1.x config hook asked for, in 2.x terms. Plain data, so two results compare by JSON. */
export type DesiredConfig = {
  readonly agents: ReadonlyArray<readonly [string, V2AgentPatch]>
  readonly agentModels: ReadonlyArray<readonly [string, V2ModelRef]>
  readonly globalPermissions: ReadonlyArray<V2PermissionRule>
  readonly mcp: ReadonlyArray<readonly [string, V2McpServerConfig]>
  /** MCP entries 2.x cannot represent; the bridge warns about them. */
  readonly skippedMcp: ReadonlyArray<string>
  readonly commands: ReadonlyArray<readonly [string, CommandSpec]>
  /** Command entries without a usable template; the bridge warns about them. */
  readonly skippedCommands: ReadonlyArray<string>
  readonly defaultAgent?: string
}

export const EMPTY_DESIRED_CONFIG: DesiredConfig = { agents: [], agentModels: [], globalPermissions: [], mcp: [], skippedMcp: [], commands: [], skippedCommands: [] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function readDesiredConfig(config: Readonly<Record<string, unknown>>, host?: { readonly hooks?: Hooks; readonly models: readonly V2ModelInfo[] }): DesiredConfig {
  const agents = isRecord(config.agent)
    ? Object.entries(config.agent).flatMap(([id, entry]): Array<readonly [string, V2AgentPatch]> =>
        isRecord(entry) ? [[id, migrateAgentConfig(entry)]] : [],
      )
    : []
  const agentModels: Array<readonly [string, V2ModelRef]> = []
  for (const [id, override] of Object.entries(host?.hooks ? agentModelOverrides.get(host.hooks) ?? {} : {})) {
    if (!override) continue
    const parsed = override.model ? parseModelString(override.model) : undefined
    if (!parsed) continue
    const modelID = transformModelForProvider(parsed.providerID, parsed.modelID)
    const lowered = lowerReasoningForModel(override.reasoning ?? override.variant ?? parsed.variant ?? override.reasoningEffort, { providerID: parsed.providerID, modelID })
    const candidate = lowered.variant ?? lowered.reasoningEffort
    const model = host?.models.find((entry) => entry.providerID === parsed.providerID && entry.modelID === modelID)
    const variant = model?.variants.find((entry) => entry.id === candidate)?.id
    agentModels.push([id, { providerID: parsed.providerID, id: modelID, ...(variant === undefined ? {} : { variant }) }])
  }
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
        },
      ])
    }
  }
  return {
    agents,
    agentModels,
    globalPermissions: migratePermissionConfig(config.tools, config.permission),
    mcp,
    skippedMcp,
    commands,
    skippedCommands,
    ...(typeof config.default_agent === "string" ? { defaultAgent: config.default_agent } : {}),
  }
}
