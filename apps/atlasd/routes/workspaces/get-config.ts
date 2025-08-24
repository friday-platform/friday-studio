import { describeRoute, resolver, validator } from "hono-openapi";
import { daemonFactory } from "../../src/factory.ts";
import {
  errorResponseSchema,
  workspaceConfigResponseSchema,
  workspaceIdParamSchema,
} from "./schemas.ts";

const getWorkspaceConfig = daemonFactory.createApp();

getWorkspaceConfig.get(
  "/",
  describeRoute({
    tags: ["Workspaces"],
    summary: "Get workspace configuration",
    description:
      "Returns the complete workspace configuration for agent server consumption, including MCP server configurations and agent definitions",
    responses: {
      200: {
        description: "Successfully retrieved workspace configuration",
        content: { "application/json": { schema: resolver(workspaceConfigResponseSchema) } },
      },
      404: {
        description: "Workspace not found",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  validator("param", workspaceIdParamSchema),
  async (c) => {
    const { workspaceId } = c.req.valid("param");

    try {
      const ctx = c.get("app");
      const manager = ctx.getWorkspaceManager();
      const workspace = await manager.find({ id: workspaceId });

      if (!workspace) {
        return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
      }

      // Load the workspace configuration using WorkspaceManager
      // This handles both filesystem and system workspaces
      const config = await manager.getWorkspaceConfig(workspace.id);
      if (!config) {
        return c.json({ error: `Failed to load workspace configuration: ${workspace.id}` }, 500);
      }

      // Return just the config portion that agents need
      return c.json({ config: config.workspace });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if it's a "not found" error
      if (errorMessage.includes("not found")) {
        return c.json({ error: errorMessage }, 404);
      }

      return c.json({ error: `Failed to get workspace config: ${errorMessage}` }, 500);
    }
  },
);

export { getWorkspaceConfig };
