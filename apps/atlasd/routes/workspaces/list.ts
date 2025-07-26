import { z } from "zod/v4";
import { daemonFactory } from "../../src/factory.ts";
import { describeRoute, resolver } from "hono-openapi";
import { errorResponseSchema, workspaceResponseSchema } from "./schemas.ts";

const listWorkspaces = daemonFactory.createApp();

listWorkspaces.get(
  "/",
  describeRoute({
    tags: ["Workspaces"],
    summary: "List all workspaces",
    description:
      "Returns a list of all registered workspaces with their current status and runtime information",
    responses: {
      200: {
        description: "Successfully retrieved workspaces",
        content: {
          "application/json": {
            schema: resolver(z.array(workspaceResponseSchema)),
          },
        },
      },
      500: {
        description: "Internal server error",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
    },
  }),
  async (c) => {
    try {
      const ctx = c.get("app");
      const manager = ctx.getWorkspaceManager();
      const workspaces = await manager.list({ includeSystem: true });
      return c.json(workspaces);
    } catch (error) {
      return c.json({
        error: `Failed to list workspaces: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }, 500);
    }
  },
);

export { listWorkspaces };
