import { z } from "zod/v4";
import { daemonFactory } from "../src/factory.ts";
import { describeRoute } from "hono-openapi";
import { resolver } from "hono-openapi/zod";
import { getWorkspaceManager } from "../../../src/core/workspace-manager.ts";

// Create app instance using factory
const workspacesRoutes = daemonFactory.createApp();

// ============================================================================
// Zod Schemas
// ============================================================================

// Workspace status enum schema
const workspaceStatusSchema = z.enum([
  "stopped",
  "starting",
  "running",
  "stopping",
  "crashed",
  "unknown",
]).meta({ description: "Current status of the workspace" });

// Response schemas
export const workspaceResponseSchema = z.object({
  id: z.string().meta({ description: "Unique workspace identifier (Docker-style name)" }),
  name: z.string().meta({ description: "Human-readable workspace name" }),
  description: z.string().optional().meta({ description: "Workspace description" }),
  status: workspaceStatusSchema,
  path: z.string().meta({ description: "Filesystem path to the workspace" }),
  hasActiveRuntime: z.boolean().meta({
    description: "Whether the workspace has an active runtime",
  }),
  createdAt: z.string().meta({ description: "ISO 8601 timestamp when workspace was created" }),
  lastSeen: z.string().meta({ description: "ISO 8601 timestamp when workspace was last seen" }),
}).meta({
  description: "Workspace information",
});

// Standard error response schema
export const errorResponseSchema = z.object({
  error: z.string().meta({ description: "Error message" }),
  code: z.string().optional().meta({ description: "Error code" }),
  details: z.any().optional().meta({ description: "Additional error details" }),
}).meta({
  description: "Standard error response",
});

// Type inference
export type WorkspaceResponse = z.infer<typeof workspaceResponseSchema>;

// ============================================================================
// Route Implementations
// ============================================================================

// List all registered workspaces
workspacesRoutes.get(
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
      const manager = getWorkspaceManager();
      const workspaces = await manager.listWorkspaces();
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

export { workspacesRoutes };
