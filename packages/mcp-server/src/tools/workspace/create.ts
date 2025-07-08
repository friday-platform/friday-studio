/**
 * Workspace create tool for MCP server
 * Creates new Atlas workspaces through the daemon API
 */

import { z } from "zod/v4";
import type { ToolHandler } from "../types.ts";
import { createSuccessResponse } from "../types.ts";

const schema = z.object({
  name: z.string().min(1).describe(
    "Human-readable workspace identifier for organization and reference (e.g., 'my-api-project', 'data-pipeline')",
  ),
  description: z.string().optional().describe(
    "Optional detailed description explaining the workspace's purpose, scope, and intended use",
  ),
  template: z.string().optional().describe(
    "Optional template name to bootstrap the workspace with predefined configuration, jobs, and structure",
  ),
  config: z.record(z.string(), z.unknown()).optional().describe(
    "Optional custom configuration settings to override template defaults or add workspace-specific behavior",
  ),
});

export const workspaceCreateTool: ToolHandler<typeof schema> = {
  name: "workspace_create",
  description:
    "Create a new Atlas workspace for organizing domain-specific automation. Workspaces define jobs (multi-step workflows), agents (LLM or remote specialists), signals (triggers like webhooks, timers, file changes), and MCP tool integrations. Each workspace represents a specialized automation environment for specific business purposes like code analysis, document processing, or system monitoring.",
  inputSchema: schema,
  handler: async ({ name, description, template, config }, { daemonUrl, logger }) => {
    logger.info("MCP workspace_create called", { name, description, template });

    try {
      const response = await fetch(`${daemonUrl}/api/workspaces`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          description,
          template,
          config,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
        );
      }

      const workspace = await response.json();

      logger.info("Workspace created via daemon API", workspace);

      return createSuccessResponse({
        success: true,
        workspace,
        message: `Workspace '${workspace.name}' created`,
        source: "daemon_api",
      });
    } catch (error) {
      logger.error("MCP workspace_create failed", { error });
      throw error;
    }
  },
};
