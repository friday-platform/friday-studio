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

export function registerDraftCreateTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_workspace_draft_create",
    {
      description:
        "Create a new workspace draft with optional initial configuration for development and testing. The draft allows iterative configuration building with validation before final publication.",
      inputSchema: {
        name: z.string().min(1).max(255).describe(
          "Human-readable workspace name (e.g., 'my-api-project', 'data-pipeline')",
        ),
        description: z.string().min(1).max(1000).describe(
          "Clear description of the workspace's purpose and functionality",
        ),
        initialConfig: ConfigRecordSchema.optional().describe(
          "Optional initial workspace configuration following WorkspaceConfig schema (object or JSON string)",
        ),
        sessionId: z.string().optional().describe(
          "Session ID for draft association (optional, uses current context if not provided)",
        ),
        conversationId: z.string().optional().describe(
          "Conversation ID for draft association (optional, uses sessionId as fallback)",
        ),
      },
    },
    async ({ name, description, initialConfig, sessionId, conversationId }) => {
      ctx.logger.info("MCP workspace_draft_create called", { name, description });

      try {
        const parsedConfig = initialConfig ? parseConfigRecord(initialConfig) : undefined;
        const response = await fetchWithTimeout(`${ctx.daemonUrl}/api/drafts`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name,
            description,
            initialConfig: parsedConfig,
            sessionId,
            conversationId: conversationId || sessionId, // Use sessionId as fallback
          }),
        });

        const result = await handleDaemonResponse(response, "workspace_draft_create", ctx.logger);

        ctx.logger.info("MCP workspace_draft_create response", {
          success: result.success,
          draftId: result.draft?.id,
          validation: result.validation?.valid,
        });

        return createSuccessResponse({
          ...result,
          source: "daemon_api",
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        ctx.logger.error("MCP workspace_draft_create failed", { error });
        throw error;
      }
    },
  );
}
