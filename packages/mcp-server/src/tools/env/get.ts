import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";
import { EnvScopeSchema, envRouteBase, isSecretKey, MASKED_VALUE } from "./shared.ts";

/** Register the `env_get` platform tool — read one env value at a scope. */
export function registerEnvGetTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "env_get",
    {
      description:
        "Read one environment variable at a scope. `workspace` reads that workspace's `.env`; " +
        "`global` reads the daemon's `.env`. If the key looks secret-bearing " +
        "(token/key/secret/password/credential) the value is masked — view a real secret in the " +
        "settings UI. Reads work across any workspace.",
      inputSchema: {
        scope: EnvScopeSchema.default("workspace").describe(
          "'workspace' (default) or 'global' (the daemon's .env)",
        ),
        workspaceId: z
          .string()
          .optional()
          .describe("Required when scope is 'workspace' — the workspace whose .env to read"),
        key: z.string().min(1).describe("Environment variable name"),
      },
    },
    async ({ scope, workspaceId, key }): Promise<CallToolResult> => {
      ctx.logger.info("MCP env_get called", { scope, workspaceId, key });

      const route = envRouteBase(ctx.daemonUrl, scope, workspaceId);
      if (!route.ok) return createErrorResponse(route.error);

      try {
        const res = await fetch(`${route.base}/${encodeURIComponent(key)}`);
        if (res.status === 404) {
          return createSuccessResponse({ scope, key, found: false });
        }
        if (!res.ok) {
          return createErrorResponse(`env get failed: HTTP ${res.status}`, await res.text());
        }
        const body = (await res.json()) as { value?: string };
        const rawValue = body.value ?? "";
        const secret = isSecretKey(key);
        return createSuccessResponse({
          scope,
          ...(scope === "workspace" && workspaceId ? { workspaceId } : {}),
          key,
          found: true,
          value: secret ? MASKED_VALUE : rawValue,
          ...(secret
            ? {
                masked: true,
                note: "Key looks secret-bearing — value withheld from tool output. View it in the settings UI.",
              }
            : {}),
        });
      } catch (err) {
        ctx.logger.error("env_get fetch error", { scope, workspaceId, key, error: err });
        return createErrorResponse("env get failed: network error", stringifyError(err));
      }
    },
  );
}
