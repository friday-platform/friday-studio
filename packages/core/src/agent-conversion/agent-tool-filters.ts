import type { AtlasTool, AtlasTools } from "@atlas/agent-sdk";
import { PLATFORM_TOOL_NAMES } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";

export { PLATFORM_TOOL_NAMES };

/**
 * Platform tools whose execute calls get workspaceId/workspaceName auto-injected
 * from the engine scope. Workspace identity is supplied by the runtime, so
 * callers (LLM tool calls, hand-written agent code) never need to know
 * workspaceId. Caller-supplied workspaceId is overridden — defense in depth.
 *
 * Memory tools are validated against workspace.yml memory.own / mounts in the
 * tool handler, so workspace agents can only write stores their workspace
 * declares.
 */
export const SCOPE_INJECTED_PLATFORM_TOOLS = new Set([
  "webfetch",
  "artifacts_create",
  "artifacts_get",
  "artifacts_update",
  "state_append",
  "state_filter",
  "state_lookup",
  "memory_save",
  "memory_read",
  "memory_remove",
]);

export interface ToolScope {
  workspaceId: string;
  workspaceName?: string;
}

/**
 * Wrap allowlisted platform tools so their execute calls receive workspaceId
 * (and optionally workspaceName) from the runtime scope. Non-platform tools
 * and platform tools outside the allowlist pass through unwrapped.
 *
 * Caller-supplied workspaceId is overridden — defense in depth: the LLM (or
 * agent code) cannot smuggle a foreign workspaceId past the runtime.
 */
export function wrapPlatformToolsWithScope(
  tools: AtlasTools,
  scope: ToolScope,
  allowlist: ReadonlySet<string> = SCOPE_INJECTED_PLATFORM_TOOLS,
): AtlasTools {
  const out: AtlasTools = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!allowlist.has(name) || !tool.execute) {
      out[name] = tool;
      continue;
    }
    const origExecute = tool.execute as NonNullable<AtlasTool["execute"]>;
    out[name] = {
      ...tool,
      execute: ((args, opts) =>
        origExecute(
          {
            ...(args as Record<string, unknown>),
            workspaceId: scope.workspaceId,
            ...(scope.workspaceName && { workspaceName: scope.workspaceName }),
          },
          opts,
        )) as AtlasTool["execute"],
    };
  }
  return out;
}

/**
 * Platform tools that workspace LLM agents and `type: user` SDK agents are
 * allowed to use. Subset of PLATFORM_TOOL_NAMES — tools NOT in this set are
 * blocked. External MCP server tools always pass through regardless of this
 * list. Workspace-management tools (workspace_delete, session_describe, etc.)
 * are intentionally excluded so a workspace agent can't escape its own scope.
 */
export const LLM_AGENT_ALLOWED_PLATFORM_TOOLS = new Set([
  // Filesystem
  "fs_glob",
  "fs_grep",
  "fs_list_files",
  "fs_read_file",
  "fs_write_file",
  // Artifacts
  "artifacts_create",
  "artifacts_get",
  "artifacts_update",
  "artifacts_get_by_chat",
  "artifacts_delete",
  // System / data processing
  "bash",
  "csv",
  "webfetch",
  // Memory — adapter-agnostic
  "memory_save",
  "memory_read",
  "memory_remove",
  // State — workspace-scoped ephemeral storage (same security profile as memory)
  "state_append",
  "state_filter",
  "state_lookup",
  // Workspace (limited)
  "convert_task_to_workspace",
  "workspace_signal_trigger",
]);

/**
 * Filters platform tools to only those explicitly allowed for LLM agents.
 * External MCP server tools (not in PLATFORM_TOOL_NAMES) pass through unfiltered.
 *
 * Uses ALLOW list strategy: new platform tools are blocked by default until
 * explicitly added to LLM_AGENT_ALLOWED_PLATFORM_TOOLS.
 *
 * @see packages/mcp-server/src/tools/index.ts — canonical tool registration
 */
export function filterWorkspaceAgentTools(tools: AtlasTools, logger: Logger): AtlasTools {
  const filtered = Object.fromEntries(
    Object.entries(tools).filter(([name]) => {
      const isPlatformTool = PLATFORM_TOOL_NAMES.has(name);
      return !isPlatformTool || LLM_AGENT_ALLOWED_PLATFORM_TOOLS.has(name);
    }),
  );
  logger.debug("Filtered tool names for LLM agent", { toolNames: Object.keys(filtered) });
  return filtered;
}
