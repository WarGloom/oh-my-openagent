import type { OhMyOpenCodeConfig } from "../config";
import { loadMcpConfigs } from "../features/claude-code-mcp-loader";
import { createBuiltinMcps } from "../mcp";
import type { PluginComponents } from "./plugin-components-loader";
import { log } from "../shared";

type McpEntry = Record<string, unknown>;

function isDisabledMcpEntry(value: unknown): value is McpEntry & { enabled: false } {
  return typeof value === "object" && value !== null && (value as McpEntry).enabled === false;
}

function captureUserDisabledMcps(
  userMcp: Record<string, unknown> | undefined
): Set<string> {
  const disabled = new Set<string>();
  if (!userMcp) return disabled;

  for (const [name, value] of Object.entries(userMcp)) {
    if (isDisabledMcpEntry(value)) {
      disabled.add(name);
    }
  }

  return disabled;
}

function prioritizeUserConfiguredMcps(
  merged: Record<string, McpEntry>,
  userMcp: Record<string, unknown> | undefined,
): Record<string, McpEntry> {
  if (!userMcp) {
    return merged;
  }

  const prioritized: Record<string, McpEntry> = {};

  for (const name of Object.keys(userMcp)) {
    if (merged[name]) {
      prioritized[name] = merged[name];
    }
  }

  for (const [name, value] of Object.entries(merged)) {
    if (!(name in prioritized)) {
      prioritized[name] = value;
    }
  }

  return prioritized;
}

export async function applyMcpConfig(params: {
  config: Record<string, unknown>;
  ctx: { directory: string };
  pluginConfig: OhMyOpenCodeConfig;
  pluginComponents: PluginComponents;
}): Promise<void> {
  const disabledMcps = params.pluginConfig.disabled_mcps ?? [];
  const userMcp = params.config.mcp as Record<string, unknown> | undefined;
  const userDisabledMcps = captureUserDisabledMcps(userMcp);

  const mcpResult = params.pluginConfig.claude_code?.mcp ?? true
    ? await loadMcpConfigs(disabledMcps)
    : { servers: {} };

  if (userMcp) {
    for (const name of Object.keys(userMcp)) {
      if (name in mcpResult.servers) {
        log(`warning: MCP server "${name}" from user config overrides Claude Code .mcp.json`);
      }
    }
  }

  // Spread order determines collision winners (last write wins).
  // userMcp spreads after mcpResult so user config overrides Claude Code
  // on name collision. prioritizeUserConfiguredMcps (called below) then
  // reorders keys so user-configured MCPs appear first in opencode's MCP
  // state, which controls the trim order of any downstream tool-budget
  // filter — user MCPs survive trimming when many MCP servers are loaded.
  const merged = {
    ...createBuiltinMcps(disabledMcps, params.pluginConfig, { cwd: params.ctx.directory }),
    ...mcpResult.servers,
    ...(userMcp ?? {}),
    ...params.pluginComponents.mcpServers,
  } as Record<string, McpEntry>;

  for (const name of userDisabledMcps) {
    if (merged[name]) {
      merged[name] = { ...merged[name], enabled: false };
    }
  }

  const disabledSet = new Set(disabledMcps);
  for (const name of disabledSet) {
    delete merged[name];
  }

  params.config.mcp = prioritizeUserConfiguredMcps(merged, userMcp);
}
