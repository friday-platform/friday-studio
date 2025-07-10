import { z } from "zod/v4";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute } from "@hono/zod-openapi";
import type { AppVariables } from "../src/factory.ts";
import "@hono/zod-validator"; // Ensure this dependency is bundled
import "zod-openapi"; // Ensure this dependency is bundled
import { getWorkspaceManager } from "../../../src/core/workspace-manager.ts";

// Create app instance using OpenAPI Hono
const workspacesRoutes = new OpenAPIHono<AppVariables>();

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

// Runtime info schema
const workspaceRuntimeSchema = z.object({
  status: z.string().meta({ description: "Runtime status" }),
  startedAt: z.string().meta({ description: "ISO 8601 timestamp when runtime started" }),
  sessions: z.number().meta({ description: "Number of active sessions" }),
  workers: z.number().meta({ description: "Number of active workers" }),
}).meta({
  description: "Runtime information for an active workspace",
});

// Detailed workspace response schema (includes config and runtime info)
export const workspaceDetailsResponseSchema = z.object({
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
  config: z.unknown().meta({ description: "Full workspace configuration" }),
  runtime: workspaceRuntimeSchema.optional().meta({
    description: "Runtime information if the workspace is active",
  }),
}).meta({
  description: "Detailed workspace information including configuration and runtime status",
});

// Parameter schemas
export const workspaceIdParamSchema = z.object({
  workspaceId: z.string().meta({ description: "Workspace identifier" }),
});

// Standard error response schema
export const errorResponseSchema = z.object({
  error: z.string().meta({ description: "Error message" }),
  code: z.string().optional().meta({ description: "Error code" }),
  details: z.unknown().optional().meta({ description: "Additional error details" }),
}).meta({
  description: "Standard error response",
});

// Type inference
export type WorkspaceResponse = z.infer<typeof workspaceResponseSchema>;
export type WorkspaceDetailsResponse = z.infer<typeof workspaceDetailsResponseSchema>;

// ============================================================================
// Route Implementations
// ============================================================================

// List all registered workspaces
const listWorkspacesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Workspaces"],
  summary: "List all workspaces",
  description:
    "Returns a list of all registered workspaces with their current status and runtime information",
  responses: {
    200: {
      description: "Successfully retrieved workspaces",
      content: {
        "application/json": {
          schema: z.array(workspaceResponseSchema),
        },
      },
    },
    500: {
      description: "Internal server error",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

workspacesRoutes.openapi(listWorkspacesRoute, async (c) => {
  try {
    const manager = await getWorkspaceManager();
    const workspaces = await manager.listWorkspaces();
    return c.json(workspaces);
  } catch (error) {
    return c.json({
      error: `Failed to list workspaces: ${error instanceof Error ? error.message : String(error)}`,
    }, 500);
  }
});

// Get workspace details by ID
const getWorkspaceRoute = createRoute({
  method: "get",
  path: "/{workspaceId}",
  tags: ["Workspaces"],
  summary: "Get workspace details",
  description:
    "Returns detailed information about a specific workspace including its configuration and runtime status",
  request: {
    params: workspaceIdParamSchema,
  },
  responses: {
    200: {
      description: "Successfully retrieved workspace details",
      content: {
        "application/json": {
          schema: workspaceDetailsResponseSchema,
        },
      },
    },
    404: {
      description: "Workspace not found",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    500: {
      description: "Internal server error",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

workspacesRoutes.openapi(getWorkspaceRoute, async (c) => {
  const { workspaceId } = c.req.valid("param");

  try {
    const manager = await getWorkspaceManager();
    const workspace = await manager.getWorkspace(workspaceId);

    if (!workspace) {
      return c.json({
        error: `Workspace not found: ${workspaceId}`,
      }, 404);
    }

    return c.json(workspace);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check if it's a "not found" error
    if (errorMessage.includes("not found")) {
      return c.json({
        error: errorMessage,
      }, 404);
    }

    return c.json({
      error: `Failed to get workspace: ${errorMessage}`,
    }, 500);
  }
});

export { workspacesRoutes };
