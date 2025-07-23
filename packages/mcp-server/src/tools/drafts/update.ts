import { z } from "zod";
import type { ToolContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";
import { fetchWithTimeout, handleDaemonResponse } from "../utils.ts";

/**
 * Union schema for handling AI SDK v5 bug where models send JSON strings instead of objects
 * Note: Cannot use transforms as they don't serialize to JSON Schema for AI SDK
 */
const ConfigRecordSchema = z.union([
  z.record(z.string(), z.unknown()), // Expected object format
  z.string(), // AI SDK v5 bug: JSON strings (parsed in execute function)
]);

/**
 * Parse configuration that may be an object or JSON string
 */
function parseConfigRecord(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {
      throw new Error("Invalid JSON string in configuration parameter");
    }
  }
  if (typeof input === "object" && input !== null) {
    return input as Record<string, unknown>;
  }
  throw new Error("Configuration must be an object or JSON string");
}

export function registerDraftUpdateTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_workspace_draft_update",
    {
      description:
        "Update an existing workspace draft with configuration changes and validation. Supports iterative development with helpful error reporting.",
      inputSchema: {
        draftId: z.string().min(1).describe(
          "Unique identifier of the draft to update (obtain from workspace_draft_create or list_session_drafts)",
        ),
        updates: ConfigRecordSchema.describe(
          "Configuration updates to apply to the draft (partial WorkspaceConfig - object or JSON string)",
        ),
        updateDescription: z.string().optional().describe(
          "Optional description of what changes are being made",
        ),
      },
    },
    async ({ draftId, updates, updateDescription }) => {
      ctx.logger.info("MCP workspace_draft_update called", { draftId, updateDescription });

      try {
        const parsedUpdates = parseConfigRecord(updates);
        const response = await fetchWithTimeout(`${ctx.daemonUrl}/api/drafts/${draftId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            updates: parsedUpdates,
            updateDescription,
          }),
        });

        const result = await handleDaemonResponse(response, "workspace_draft_update", ctx.logger);

        ctx.logger.info("MCP workspace_draft_update response", {
          success: result.success,
          draftId,
          validation: result.validation?.valid,
        });

        return createSuccessResponse({
          ...result,
          source: "daemon_api",
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        ctx.logger.error("MCP workspace_draft_update failed", { draftId, error });
        throw error;
      }
    },
  );
}
