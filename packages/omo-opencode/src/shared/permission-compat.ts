/**
 * Permission system utilities for OpenCode 1.1.1+.
 * This module only supports the new permission format.
 */

/**
 * Heavy MCP tool categories that read-only/advisory agents don't need.
 * Uses wildcard patterns matched by OpenCode's Permission.disabled().
 * Denying these saves ~25-40k tokens on small-context models (copilot 128k).
 */
export const DENY_HEAVY_MCP_TOOLS: Record<string, "deny"> = {
  "mcp__plugin_playwright_*": "deny",
  "mcp__chrome-devtools__*": "deny",
  // Serena code mutation tools — keep read + memory tools available
  "mcp__plugin_serena_serena__replace_symbol_body": "deny",
  "mcp__plugin_serena_serena__replace_content": "deny",
  "mcp__plugin_serena_serena__insert_after_symbol": "deny",
  "mcp__plugin_serena_serena__insert_before_symbol": "deny",
  "mcp__plugin_serena_serena__create_text_file": "deny",
  "mcp__plugin_serena_serena__rename_symbol": "deny",
}

export type PermissionValue = "ask" | "allow" | "deny"

export interface PermissionFormat {
  permission: Record<string, PermissionValue>
}

/**
 * Creates tool restrictions that deny specified tools.
 */
export function createAgentToolRestrictions(
  denyTools: string[],
  allowTools: string[] = [],
): PermissionFormat {
  return {
    permission: Object.fromEntries([
      ...denyTools.map((tool) => [tool, "deny" as const]),
      ...allowTools.map((tool) => [tool, "allow" as const]),
    ]),
  }
}

/**
 * Creates tool restrictions that ONLY allow specified tools.
 * All other tools are denied by default using `*: deny` pattern.
 */
export function createAgentToolAllowlist(
  allowTools: string[]
): PermissionFormat {
  return {
    permission: {
      "*": "deny" as const,
      ...Object.fromEntries(
        allowTools.map((tool) => [tool, "allow" as const])
      ),
    },
  }
}

/**
 * Converts legacy tools format to permission format.
 * For migrating user configs from older versions.
 */
export function migrateToolsToPermission(
  tools: Record<string, boolean>
): Record<string, PermissionValue> {
  return Object.fromEntries(
    Object.entries(tools).map(([key, value]) => [
      key,
      value ? ("allow" as const) : ("deny" as const),
    ])
  )
}

/**
 * Migrates agent config from legacy tools format to permission format.
 * If config has `tools`, converts to `permission`.
 */
export function migrateAgentConfig(
  config: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...config }

  if (result.tools && typeof result.tools === "object") {
    const existingPermission =
      (result.permission as Record<string, PermissionValue>) || {}
    const migratedPermission = migrateToolsToPermission(
      result.tools as Record<string, boolean>
    )
    result.permission = { ...migratedPermission, ...existingPermission }
    delete result.tools
  }

  if (result.permission && typeof result.permission === "object") {
    const perm = { ...(result.permission as Record<string, PermissionValue>) }
    if ("delegate_task" in perm && !("task" in perm)) {
      perm["task"] = perm["delegate_task"]
      delete perm["delegate_task"]
      result.permission = perm
    }
  }

  return result
}
