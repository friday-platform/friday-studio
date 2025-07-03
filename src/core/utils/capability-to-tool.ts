/**
 * Convert Workspace Capabilities to AI SDK Tools
 * Enables LLM agents to use workspace capabilities as tools
 */

import { Tool } from "ai";
import type { AgentExecutionContext, WorkspaceCapability } from "../workspace-capabilities.ts";
import { z } from "zod/v4";
import { logger } from "../../utils/logger.ts";

/**
 * Convert a workspace capability to an AI SDK tool
 */
export function capabilityToTool(
  capability: WorkspaceCapability,
  context: AgentExecutionContext,
): Tool {
  // Build the input schema based on capability
  let inputSchema: any = {};

  switch (capability.id) {
    case "session_reply":
      inputSchema = z.object({
        message: z.string().describe("The complete message to send to the user"),
        conversationId: z.string().optional().describe(
          "Optional conversation ID to send the reply to. If not provided, uses the context conversationId or sessionId",
        ),
        metadata: z.object({
          analysis: z.string().optional(),
          confidence: z.number().min(0).max(1).optional(),
          complexity: z.enum(["low", "medium", "high"]).optional(),
          requiresAgentCoordination: z.boolean().optional(),
        }).optional().describe("Optional metadata about the response"),
      });
      break;

    case "session_stream":
      inputSchema = z.object({
        data: z.any().describe("Data to stream through the response channel"),
      });
      break;

    // Workspace creation capabilities
    case "workspace_draft_create":
      inputSchema = z.object({
        name: z.string().regex(
          /^[a-zA-Z][a-zA-Z0-9_-]*$/,
          "Workspace name must start with a letter and contain only letters, numbers, underscores, and hyphens",
        ).describe("Workspace name (lowercase with hyphens, no dots)"),
        description: z.string().describe("Clear description of the workspace's purpose"),
        initialConfig: z.record(z.string(), z.unknown()).optional().describe(
          "Optional initial workspace configuration following the WorkspaceConfig schema",
        ),
      });
      break;

    case "workspace_draft_update":
      inputSchema = z.object({
        draftId: z.uuid().describe("Draft workspace ID"),
        updates: z.record(z.string(), z.unknown()).describe(
          "Configuration updates to apply (Partial<WorkspaceConfig>)",
        ),
        updateDescription: z.string().describe("Natural language description of what changed"),
      });
      break;

    case "validate_draft_config":
      inputSchema = z.object({
        draftId: z.uuid().describe("Draft workspace ID to validate"),
      });
      break;

    case "pre_publish_check":
      inputSchema = z.object({
        draftId: z.uuid().describe("Draft workspace ID to check"),
      });
      break;

    case "publish_workspace":
      inputSchema = z.object({
        draftId: z.uuid().describe("Draft workspace ID to publish"),
        path: z.string().optional().describe("Optional path where workspace should be created"),
      });
      break;

    case "show_draft_config":
      inputSchema = z.object({
        draftId: z.uuid().describe("Draft workspace ID"),
        format: z.enum(["yaml", "summary"]).default("summary").describe("Output format"),
      });
      break;

    case "list_session_drafts":
      inputSchema = z.object({});
      break;

    // Library access capabilities
    case "library_list":
      inputSchema = z.object({
        type: z.enum(["report", "session_archive", "template", "artifact", "user_upload"])
          .optional()
          .describe("Filter by library item type"),
        tags: z.array(z.string()).optional().describe("Filter by tags"),
        limit: z.number().min(1).max(100).default(20).describe("Maximum number of items to return"),
        workspaceId: z.string().optional().describe("Optional workspace ID to filter results"),
      });
      break;

    case "library_get":
      inputSchema = z.object({
        itemId: z.string().describe("The ID of the library item to retrieve"),
        includeContent: z.boolean().default(true).describe("Whether to include the full content"),
        workspaceId: z.string().optional().describe("Optional workspace ID if workspace-specific"),
      });
      break;

    case "library_search":
      inputSchema = z.object({
        query: z.string().describe("Search query"),
        type: z.enum(["report", "session_archive", "template", "artifact", "user_upload"])
          .optional()
          .describe("Filter by library item type"),
        tags: z.array(z.string()).optional().describe("Filter by tags"),
        since: z.string().optional().describe("ISO date string - items created after this date"),
        until: z.string().optional().describe("ISO date string - items created before this date"),
        limit: z.number().min(1).max(100).default(20).describe("Maximum number of results"),
      });
      break;

    default:
      // Generic schema for other capabilities
      inputSchema = z.object({
        args: z.array(z.any()).optional(),
      });
  }

  return {
    description: capability.description,
    parameters: inputSchema,
    execute: async (args: any) => {
      logger.debug(`Executing workspace capability ${capability.id}`, {
        capability: capability.id,
        sessionId: context.sessionId,
        agentId: context.agentId,
      });

      try {
        // Execute the capability with proper argument unpacking
        let result: any;
        if (capability.id === "session_reply" && args) {
          result = await capability.implementation(
            context,
            args.message,
            args.metadata,
            args.conversationId,
          );
        } else if (capability.id === "session_stream" && args) {
          result = await capability.implementation(context, args.data);
        } else if (capability.id === "workspace_draft_create" && args) {
          result = await capability.implementation(
            context,
            args.name,
            args.description,
            args.initialConfig,
          );
        } else if (capability.id === "workspace_draft_update" && args) {
          result = await capability.implementation(
            context,
            args.draftId,
            args.updates,
            args.updateDescription,
          );
        } else if (capability.id === "validate_draft_config" && args) {
          result = await capability.implementation(context, args.draftId);
        } else if (capability.id === "pre_publish_check" && args) {
          result = await capability.implementation(context, args.draftId);
        } else if (capability.id === "publish_workspace" && args) {
          result = await capability.implementation(context, args.draftId, args.path);
        } else if (capability.id === "show_draft_config" && args) {
          result = await capability.implementation(context, args.draftId, args.format);
        } else if (capability.id === "list_session_drafts") {
          result = await capability.implementation(context);
        } else if (capability.id === "library_list" && args) {
          result = await capability.implementation(
            context,
            args.type,
            args.tags,
            args.limit,
            args.workspaceId,
          );
        } else if (capability.id === "library_get" && args) {
          result = await capability.implementation(
            context,
            args.itemId,
            args.includeContent,
            args.workspaceId,
          );
        } else if (capability.id === "library_search" && args) {
          result = await capability.implementation(
            context,
            args.query,
            args.type,
            args.tags,
            args.since,
            args.until,
            args.limit,
          );
        } else if (args?.args && Array.isArray(args.args)) {
          result = await capability.implementation(context, ...args.args);
        } else {
          result = await capability.implementation(context);
        }

        return result || { success: true };
      } catch (error) {
        logger.error(`Failed to execute capability ${capability.id}`, {
          capability: capability.id,
          error: error instanceof Error ? error.message : String(error),
          sessionId: context.sessionId,
          agentId: context.agentId,
        });

        throw error;
      }
    },
  };
}

/**
 * Convert multiple workspace capabilities to AI SDK tools
 */
export function capabilitiesToTools(
  capabilities: WorkspaceCapability[],
  context: AgentExecutionContext,
): Record<string, Tool> {
  const tools: Record<string, Tool> = {};

  for (const capability of capabilities) {
    tools[capability.id] = capabilityToTool(capability, context);
  }

  return tools;
}
