import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";
import { EnvScopeSchema, envRouteBase } from "./shared.ts";

/**
 * Register the `env_delete` platform tool — remove one env value.
 *
 * Scope-injected: `workspaceId` is supplied by the runtime, so a `workspace`
 * delete only ever touches the *current* workspace's `.env` (an agent can't
 * delete from a foreign workspace). `global` deletes the daemon's `.env`.
 * Direct (no confirmation card) — like `delete_memory_entry`.
 */
export function registerEnvDeleteTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "env_delete",
    {
      description:
        "Delete one environment variable. `workspace` removes it from the current workspace's " +
        "`.env`; `global` removes it from the daemon's `.env`. Comment-preserving — other keys " +
        "and comments are untouched.",
      inputSchema: {
        scope: EnvScopeSchema.default("workspace").describe(
          "'workspace' (default, the current workspace's .env) or 'global' (the daemon's .env)",
        ),
        key: z.string().min(1).describe("Environment variable name to delete"),
        // ── Scope-injected (do not provide; runtime overrides) ───────────
        workspaceId: z.string().describe("(runtime-injected) current workspace identity"),
      },
    },
    async ({ scope, key, workspaceId }): Promise<CallToolResult> => {
      ctx.logger.info("MCP env_delete called", { scope, workspaceId, key });

      const route = envRouteBase(ctx.daemonUrl, scope, workspaceId);
      if (!route.ok) return createErrorResponse(route.error);

      try {
        const res = await fetch(`${route.base}/${encodeURIComponent(key)}`, { method: "DELETE" });
        if (!res.ok) {
          return createErrorResponse(`env delete failed: HTTP ${res.status}`, await res.text());
        }
        const body = (await res.json()) as { removed?: boolean };
        return createSuccessResponse({
          scope,
          ...(scope === "workspace" ? { workspaceId } : {}),
          key,
          removed: body.removed ?? false,
        });
      } catch (err) {
        ctx.logger.error("env_delete fetch error", { scope, workspaceId, key, error: err });
        return createErrorResponse("env delete failed: network error", stringifyError(err));
      }
    },
  );
}
