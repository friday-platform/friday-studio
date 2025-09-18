import { describeRoute, resolver, validator } from "hono-openapi";
import { daemonFactory } from "../../src/factory.ts";
import {
  errorResponseSchema,
  workspaceDetailsResponseSchema,
  workspaceIdParamSchema,
} from "./schemas.ts";

const getWorkspace = daemonFactory.createApp();

getWorkspace.get(
  "/",
  describeRoute({
    tags: ["Workspaces"],
    summary: "Get workspace details",
    description:
      "Returns detailed information about a specific workspace including its configuration and runtime status",
    responses: {
      200: {
        description: "Successfully retrieved workspace details",
        content: { "application/json": { schema: resolver(workspaceDetailsResponseSchema) } },
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

      // Try to find by ID first, then by name (matching CLI behavior)
      const workspace =
        (await manager.find({ id: workspaceId })) || (await manager.find({ name: workspaceId }));

      if (!workspace) {
        return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
      }

      return c.json(workspace);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if it's a "not found" error
      if (errorMessage.includes("not found")) {
        return c.json({ error: errorMessage }, 404);
      }

      return c.json({ error: `Failed to get workspace: ${errorMessage}` }, 500);
    }
  },
);

export { getWorkspace };
