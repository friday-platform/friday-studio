import process from "node:process";
import { PLATFORM_TOOL_NAMES } from "@atlas/agent-sdk";
import { resolvePermissions } from "@atlas/config/permissions";
import { ElicitationStorage, ToolAccessGrants } from "@atlas/core/elicitations";
import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { deriveElicitationExpiresAt, waitForTerminalElicitation } from "../elicitations/wait.ts";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

const DISCOVERY_TOOLS = [
  "list_capabilities",
  "search_mcp_servers",
  "install_mcp_server",
  "enable_mcp_server",
  "disable_mcp_server",
  "create_mcp_server",
  "get_mcp_dependencies",
  "list_mcp_tools",
  "connect_service",
  "connect_communicator",
];
/**
 * Zod shape for a `PermissionsConfig` mirror. Kept narrow on purpose — the
 * tool only cares about `dangerouslySkipAllowlist` today; future fields
 * land here when other permissions resolve at call time.
 */
const PermissionsShape = z.object({ dangerouslySkipAllowlist: z.boolean().optional() });

/** Pre-resolved permissions shape used as the single source of truth. */
const ResolvedPermissionsShape = z.object({ dangerouslySkipAllowlist: z.boolean() });

/**
 * Register the `request_tool_access` platform tool.
 *
 * The LLM calls this when it wants to invoke a tool that isn't in its
 * allowlist. The tool resolves effective permissions (job > workspace >
 * daemon env) and either:
 *
 * 1. **Bypass branch** — `dangerouslySkipAllowlist` resolves `true`, so the
 *    tool returns `{ ok: true, granted: true, reason: "bypass" }` and logs at
 *    info level so operators can see it in the global log.
 * 2. **Elicitation branch** — emits a `tool-allowlist` elicitation via
 *    `ElicitationStorage.create`, blocks on the shared elicitation wait
 *    primitive, and returns the user's terminal decision.
 *
 * Scope injection: `workspaceId`, `sessionId`, `actionId`, `jobPermissions`,
 * and `workspacePermissions` are filled in by `wrapPlatformToolsWithScope`
 * at the AI-SDK boundary. They appear in the input schema because the
 * wrapper merges them into args before MCP-side Zod validation runs.
 */
export function registerRequestToolAccessTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "request_tool_access",
    {
      description:
        "Request permission to call a tool that isn't in your allowlist. " +
        "Use this when you need a capability you don't currently have. " +
        'Returns immediately with `{ granted: true, persistent: false, reason: "bypass" }` ' +
        "if the current job/workspace has `permissions.dangerouslySkipAllowlist`. " +
        "Otherwise emits a user-facing elicitation, blocks until it is answered, " +
        "declined, or expired, and returns the terminal decision. " +
        "Read `persistent` on the response: `true` means the tool will be " +
        "available to future actions in this workspace without re-asking; " +
        "`false` means this turn is the only effect — you still cannot call " +
        "the requested tool in the current action and must route around.",
      inputSchema: {
        toolName: z.string().min(1).describe("Name of the tool you want to call"),
        reason: z
          .string()
          .min(1)
          .describe("Short rationale for the user — why you need this tool right now"),
        // ── Scope-injected fields (do not provide; runtime overrides) ─────
        workspaceId: z.string().describe("(runtime-injected) workspace identity"),
        sessionId: z.string().optional().describe("(runtime-injected) session identity"),
        actionId: z.string().optional().describe("(runtime-injected) FSM action id"),
        // Prefer pre-resolved permissions when the runtime has already merged
        // job/workspace/daemon settings. The raw fields below remain a
        // fall-through for callers that don't have a resolution context handy.
        resolvedPermissions: ResolvedPermissionsShape.optional().describe(
          "(runtime-injected) effective permissions, pre-resolved",
        ),
        jobPermissions: PermissionsShape.optional().describe(
          "(runtime-injected) per-job permissions config (fallback if resolvedPermissions absent)",
        ),
        workspacePermissions: PermissionsShape.optional().describe(
          "(runtime-injected) workspace-level permissions config (fallback)",
        ),
        // When set, derives expiresAt = now + jobTimeoutMs so the elicitation
        // TTL matches the job lifetime. Falls back to
        // DEFAULT_ELICITATION_TTL_MS.
        jobTimeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("(runtime-injected) parent job timeout in ms"),
        availableToolNames: z
          .array(z.string())
          .optional()
          .describe("(runtime-injected) catalog of real tools known to this runtime"),
      },
    },
    async ({
      toolName,
      reason,
      workspaceId,
      sessionId,
      actionId,
      resolvedPermissions,
      jobPermissions,
      workspacePermissions,
      jobTimeoutMs,
      availableToolNames,
    }): Promise<CallToolResult> => {
      // Prefer resolvedPermissions when present. Falls back to resolving from
      // raw fields at call time so callers without a resolution context still
      // work.
      const effective =
        resolvedPermissions ??
        resolvePermissions({
          job: jobPermissions,
          workspace: workspacePermissions,
          daemonDangerouslySkipAllowlist: process.env.FRIDAY_DANGEROUSLY_SKIP_PERMISSIONS === "1",
        });

      const shouldValidateToolName = availableToolNames !== undefined;
      const knownTools = new Set([...(availableToolNames ?? []), ...PLATFORM_TOOL_NAMES]);
      if (shouldValidateToolName && !knownTools.has(toolName)) {
        ctx.logger.warn("request_tool_access rejected unknown tool", {
          toolName,
          workspaceId,
          sessionId,
          actionId,
        });
        return createSuccessResponse({
          ok: false,
          granted: false,
          reason: "unknown_tool",
          toolName,
          message: `Unknown tool '${toolName}'. Use capability discovery instead of requesting access to a guessed tool name.`,
          discoveryTools: DISCOVERY_TOOLS,
        });
      }

      const persistentGrant = await ToolAccessGrants.hasGrant({ workspaceId, toolName });
      if (persistentGrant.ok && persistentGrant.data) {
        ctx.logger.info("request_tool_access persistent grant", {
          toolName,
          workspaceId,
          sessionId,
          actionId,
          grantType: "persistent_allow",
        });
        return createSuccessResponse({
          ok: true,
          granted: true,
          persistent: true,
          reason: "persistent_allow",
        });
      }
      if (!persistentGrant.ok) {
        ctx.logger.warn("request_tool_access persistent grant check failed", {
          toolName,
          workspaceId,
          error: persistentGrant.error,
        });
      }

      if (effective.dangerouslySkipAllowlist) {
        // Bypass branch. Operators read this in ~/.atlas/logs/global.log to
        // spot which jobs run unsandboxed.
        ctx.logger.info("request_tool_access bypass", {
          toolName,
          reason,
          workspaceId,
          sessionId,
          actionId,
          grantType: "bypass",
        });
        return createSuccessResponse({
          ok: true,
          granted: true,
          persistent: false,
          reason: "bypass",
        });
      }

      // Elicitation branch. Emit a tool-allowlist elicitation and block on
      // the shared NATS/KV wait path until the user answers, declines, or the
      // request expires. Derive expiresAt from job timeout when available so
      // the elicitation TTL matches the job lifetime; else default to 30 min.
      const expiresAt = deriveElicitationExpiresAt(jobTimeoutMs);

      // Warn-log when sessionId fallback fires. The fallback is safe
      // (Activity feed shows "unknown" rather than crashing the create), but
      // it masks bugs where future call sites forget to thread sessionId
      // through scope. Loud log gives operators a breadcrumb without erroring
      // out.
      if (!sessionId) {
        ctx.logger.warn("request_tool_access: missing sessionId in scope — using 'unknown'", {
          toolName,
          workspaceId,
          actionId,
        });
      }

      try {
        const created = await ElicitationStorage.create({
          workspaceId,
          sessionId: sessionId ?? "unknown",
          ...(actionId && { actionId }),
          kind: "tool-allowlist",
          question: `Allow agent to call \`${toolName}\`? ${reason}`,
          options: [
            { label: "Allow once", value: "allow_once" },
            { label: "Allow always", value: "allow_always" },
            { label: "Deny", value: "deny" },
          ],
          pendingTool: { name: toolName, args: {} },
          expiresAt,
        });
        if (!created.ok) {
          ctx.logger.error("request_tool_access elicitation create failed", {
            toolName,
            workspaceId,
            error: created.error,
          });
          return createErrorResponse("Failed to create elicitation", created.error);
        }
        ctx.logger.info("request_tool_access elicitation created", {
          toolName,
          reason,
          workspaceId,
          sessionId,
          actionId,
          elicitationId: created.data.id,
        });
        const terminal = await waitForTerminalElicitation(ctx, {
          id: created.data.id,
          workspaceId: created.data.workspaceId,
          sessionId: created.data.sessionId,
          expiresAt: created.data.expiresAt,
        });
        if (terminal.status === "pending") {
          return createSuccessResponse({
            ok: false,
            granted: false,
            elicitationId: created.data.id,
            reason: "pending_user_approval",
          });
        }
        if (terminal.status === "answered") {
          const granted = terminal.value === "allow_once" || terminal.value === "allow_always";
          let persistent = false;
          if (terminal.value === "allow_always") {
            // Parse serverId so `buildTools` can eagerly load the source
            // MCP server on future actions. For bare names the parser
            // returns `serverId: undefined` and the grant store falls
            // through to a back-compat read path.
            const slash = toolName.indexOf("/");
            const serverId =
              slash > 0 && slash < toolName.length - 1 ? toolName.slice(0, slash) : undefined;
            const persisted = await ToolAccessGrants.grantAlways({
              workspaceId,
              toolName,
              ...(serverId && { serverId }),
              sourceElicitationId: created.data.id,
            });
            persistent = persisted.ok;
            if (!persisted.ok) {
              ctx.logger.warn("request_tool_access allow-always persistence failed", {
                toolName,
                workspaceId,
                error: persisted.error,
              });
            }
          }
          // grantType in the log makes the user's choice auditable without
          // joining against the elicitation store. The runtime difference
          // matters: `allow_always` widens future actions via the grant
          // union; `allow_once` is an approval signal only.
          ctx.logger.info("request_tool_access answered", {
            toolName,
            workspaceId,
            sessionId,
            actionId,
            elicitationId: created.data.id,
            grantType: granted ? terminal.value : "deny",
            persistent,
          });
          return createSuccessResponse({
            ok: granted,
            granted,
            persistent,
            elicitationId: created.data.id,
            answer: terminal.value,
            reason: granted ? "answered" : "declined",
            ...(terminal.note ? { note: terminal.note } : {}),
          });
        }
        return createSuccessResponse({
          ok: false,
          granted: false,
          elicitationId: created.data.id,
          reason: terminal.status,
          ...(terminal.note ? { note: terminal.note } : {}),
        });
      } catch (err) {
        ctx.logger.error("request_tool_access threw", { toolName, workspaceId, error: err });
        return createErrorResponse("request_tool_access failed", stringifyError(err));
      }
    },
  );
}
