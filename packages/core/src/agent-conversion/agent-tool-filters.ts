import type { AtlasTool, AtlasTools } from "@atlas/agent-sdk";
import { PLATFORM_TOOL_NAMES } from "@atlas/agent-sdk";
import type { PermissionsConfig, ResolvedPermissions } from "@atlas/config";
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
  "create_artifact",
  "get_artifact",
  "artifacts_update",
  "state_append",
  "state_filter",
  "state_lookup",
  "save_memory_entry",
  "list_memory_entries",
  "delete_memory_entry",
  // fs_write_file uses workspaceId to resolve relative paths against the
  // workspace working directory (`<friday-home>/workspaces/<workspaceId>/`)
  // instead of the daemon's launch directory.
  "fs_write_file",
  // Env writes are workspace-local: `workspaceId` is injected so an agent
  // can only touch its *own* workspace's `.env`, never a foreign one.
  // `env_set` also reads sessionId/actionId for the confirmation elicitation.
  // (`env_list` / `env_get` are NOT here — reads take an explicit
  // workspaceId so an agent can read across workspaces.)
  "env_set",
  "env_delete",
  // HITL tools read sessionId/actionId from the wrapper so Activity can
  // correlate the pending item and the blocked run can resume on answer.
  "request_tool_access",
  "request_human_input",
]);

export interface ToolScope {
  workspaceId: string;
  workspaceName?: string;
  /**
   * Optional session id forwarded to scope-injected tools that need it
   * (e.g. `request_tool_access` records it on the elicitation envelope so
   * the Activity page can correlate). Undefined for tools that don't need
   * session identity (most chat-side wraps).
   */
  sessionId?: string;
  /**
   * Optional FSM action id. Set when an LLM action constructs the tool set
   * inside `fsm-engine`'s `case "llm":` dispatch — `request_tool_access`
   * stamps it on the elicitation so the Activity page can link back to
   * the originating action.
   */
  actionId?: string;
  /**
   * Per-job permissions config (raw, unresolved). Forwarded to
   * `request_tool_access` so it can call `resolvePermissions` at call time
   * with the daemon-env floor. Optional — missing means "no per-job
   * override; fall through to workspace + daemon".
   *
   * Prefer setting `resolvedPermissions` (single source of truth resolved at
   * scope-construction time). Raw job/workspace fields remain supported for
   * back-compat / call-sites that don't have a resolution context handy.
   */
  jobPermissions?: PermissionsConfig;
  /**
   * Workspace-level permissions config. Same forwarding contract as
   * `jobPermissions` but at the workspace tier.
   */
  workspacePermissions?: PermissionsConfig;
  /**
   * Pre-resolved effective permissions (job > workspace > daemon env).
   * When set, scope-injected tools (e.g. `request_tool_access`) use this
   * directly instead of re-resolving from the raw fields. Resolves the
   * "two layers call resolvePermissions independently" duplication
   * flagged in 2026-05-06 review N2 — single source of truth at
   * scope-construction time.
   */
  resolvedPermissions?: ResolvedPermissions;
  /**
   * Parent job's effective timeout (ms). When set, scope-injected
   * elicitation tools derive `expiresAt = now + jobTimeoutMs` so the
   * elicitation TTL matches the job lifetime. When absent, callers fall back
   * to a tool-local default.
   */
  jobTimeoutMs?: number;
  /**
   * Tool catalog visible to the runtime before per-action allowlist narrowing.
   * `request_tool_access` uses this to reject hallucinated tools without
   * creating user-facing elicitations.
   */
  availableToolNames?: string[];
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
            // These flow into `request_tool_access` (and any future
            // scope-injected tool that needs them). Other wrapped
            // tools ignore unknown fields because their MCP-side schemas
            // don't declare them; Zod parses out only what each tool asks
            // for. Defense in depth still applies: caller-supplied values
            // are overwritten.
            ...(scope.sessionId && { sessionId: scope.sessionId }),
            ...(scope.actionId && { actionId: scope.actionId }),
            ...(scope.jobPermissions && { jobPermissions: scope.jobPermissions }),
            ...(scope.workspacePermissions && { workspacePermissions: scope.workspacePermissions }),
            ...(scope.resolvedPermissions && { resolvedPermissions: scope.resolvedPermissions }),
            ...(scope.jobTimeoutMs !== undefined && { jobTimeoutMs: scope.jobTimeoutMs }),
            ...(scope.availableToolNames && { availableToolNames: scope.availableToolNames }),
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
 * list. Workspace-management tools (delete_workspace, session_describe, etc.)
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
  "create_artifact",
  "get_artifact",
  "artifacts_update",
  "artifacts_get_by_chat",
  "artifacts_delete",
  // System / data processing
  "bash",
  "csv",
  "webfetch",
  // Memory — adapter-agnostic
  "save_memory_entry",
  "list_memory_entries",
  "delete_memory_entry",
  // Env — workspace / global `.env` CRUD (writes are workspace-local +
  // human-confirmed; reads mask secret-looking keys)
  "env_list",
  "env_get",
  "env_set",
  "env_delete",
  // State — workspace-scoped ephemeral storage (same security profile as memory)
  "state_append",
  "state_filter",
  "state_lookup",
  // Workspace (limited)
  "convert_task_to_workspace",
  "workspace_signal_trigger",
  // Human-in-the-loop / permissions.
  "request_tool_access",
  "request_human_input",
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
