import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";
import { EnvScopeSchema, envRouteBase, maskEnvMap } from "./shared.ts";

/** Register the `env_list` platform tool — list env keys + values at a scope. */
export function registerEnvListTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "env_list",
    {
      description:
        "List environment variables at a scope. `workspace` reads that workspace's `.env` " +
        "(the per-workspace non-secret value store); `global` reads the daemon's `.env`. " +
        "Values for secret-looking keys (token/key/secret/password/credential) are masked — " +
        "use the settings UI to view a real secret. Reads work across any workspace.",
      inputSchema: {
        scope: EnvScopeSchema.default("workspace").describe(
          "'workspace' (default) or 'global' (the daemon's .env)",
        ),
        workspaceId: z
          .string()
          .optional()
          .describe("Required when scope is 'workspace' — the workspace whose .env to read"),
      },
    },
    async ({ scope, workspaceId }): Promise<CallToolResult> => {
      ctx.logger.info("MCP env_list called", { scope, workspaceId });

      const route = envRouteBase(ctx.daemonUrl, scope, workspaceId);
      if (!route.ok) return createErrorResponse(route.error);

      try {
        const res = await fetch(route.base);
        if (!res.ok) {
          return createErrorResponse(`env list failed: HTTP ${res.status}`, await res.text());
        }
        const body = (await res.json()) as {
          env?: Record<string, string>;
          envVars?: Record<string, string>;
        };
        // Workspace route returns `env`; the global config route returns `envVars`.
        const raw = body.env ?? body.envVars ?? {};
        const { env, maskedKeys } = maskEnvMap(raw);
        return createSuccessResponse({
          scope,
          ...(scope === "workspace" && workspaceId ? { workspaceId } : {}),
          env,
          count: Object.keys(env).length,
          ...(maskedKeys.length > 0 ? { maskedKeys } : {}),
        });
      } catch (err) {
        ctx.logger.error("env_list fetch error", { scope, workspaceId, error: err });
        return createErrorResponse("env list failed: network error", stringifyError(err));
      }
    },
  );
}
