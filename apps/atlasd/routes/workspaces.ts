import { z } from "zod/v4";
import { daemonFactory } from "../src/factory.ts";
import { describeRoute, resolver, validator } from "hono-openapi";
import { FilesystemWorkspaceCreationAdapter } from "@atlas/storage";
import { stringify } from "@std/yaml";
import { WorkspaceConfigSchema } from "@atlas/config";

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
]).meta({
  description: "Current status of the workspace",
});

// Response schemas
export const workspaceResponseSchema = z.object({
  id: z.string().meta({ description: "Unique workspace identifier (Docker-style name)" }),
  name: z.string().meta({ description: "Human-readable workspace name" }),
  description: z.string().optional().meta({ description: "Workspace description" }),
  status: workspaceStatusSchema,
  path: z.string().meta({ description: "Filesystem path to the workspace" }),
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
  id: "ErrorResponse",
  description: "Standard error response",
});

// Type inference
export type WorkspaceResponse = z.infer<typeof workspaceResponseSchema>;
export type WorkspaceDetailsResponse = z.infer<typeof workspaceDetailsResponseSchema>;

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

// Get workspace details by ID
workspacesRoutes.get(
  "/:workspaceId",
  describeRoute({
    tags: ["Workspaces"],
    summary: "Get workspace details",
    description:
      "Returns detailed information about a specific workspace including its configuration and runtime status",
    responses: {
      200: {
        description: "Successfully retrieved workspace details",
        content: {
          "application/json": {
            schema: resolver(workspaceDetailsResponseSchema),
          },
        },
      },
      404: {
        description: "Workspace not found",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
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
  validator("param", workspaceIdParamSchema),
  async (c) => {
    const { workspaceId } = c.req.valid("param");

    try {
      const ctx = c.get("app");
      const manager = ctx.getWorkspaceManager();
      const workspace = await manager.find({ id: workspaceId });

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
  },
);

// Create workspace from generated configuration
const createWorkspaceFromConfigSchema = z.object({
  config: z.record(z.string(), z.unknown()).describe("Generated workspace configuration"),
  workspaceName: z.string().optional().describe(
    "Custom workspace directory name (auto-resolves conflicts with -2, -3, etc.)",
  ),
}).meta({ description: "Create workspace from configuration" });

const createWorkspaceFromConfigResponseSchema = z.object({
  success: z.boolean(),
  workspace: workspaceResponseSchema.optional(),
  workspacePath: z.string().optional(),
  filesCreated: z.array(z.string()).optional(),
  error: z.string().optional(),
}).meta({ description: "Create workspace from configuration response" });

workspacesRoutes.post(
  "/create",
  describeRoute({
    tags: ["Workspaces"],
    summary: "Create workspace from configuration",
    description: "Create workspace files and register workspace from generated configuration",
    responses: {
      200: {
        description: "Workspace created successfully",
        content: {
          "application/json": {
            schema: resolver(createWorkspaceFromConfigResponseSchema),
          },
        },
      },
      400: {
        description: "Invalid configuration",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
      500: {
        description: "Creation failed",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
    },
  }),
  validator("json", createWorkspaceFromConfigSchema),
  async (c) => {
    try {
      const { config, workspaceName } = c.req.valid("json");

      // Validate configuration
      const validationResult = WorkspaceConfigSchema.safeParse(config);
      if (!validationResult.success) {
        return c.json({
          success: false,
          error: `Invalid workspace configuration: ${
            validationResult.error.issues.map((issue) => issue.message).join(", ")
          }`,
        }, 400);
      }

      const validatedConfig = validationResult.data;

      // Convert config to YAML
      const yamlConfig = stringify(validatedConfig, {
        indent: 2,
        lineWidth: 100,
      });

      // Create workspace files
      const workspaceAdapter = new FilesystemWorkspaceCreationAdapter();
      const finalWorkspaceName = workspaceName || validatedConfig.workspace.name;
      const basePath = Deno.cwd(); // Always use current working directory as base

      try {
        const workspacePath = await workspaceAdapter.createWorkspaceDirectory(
          basePath,
          finalWorkspaceName,
        );

        await workspaceAdapter.writeWorkspaceFiles(workspacePath, yamlConfig);

        // Register workspace with manager
        const ctx = c.get("app");
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.registerWorkspace(workspacePath, {
          name: finalWorkspaceName,
          description: validatedConfig.workspace.description,
        });

        return c.json({
          success: true,
          workspace,
          workspacePath,
          filesCreated: ["workspace.yml", ".env"],
        });
      } catch (creationError) {
        return c.json({
          success: false,
          error: `Failed to create workspace files: ${
            creationError instanceof Error ? creationError.message : String(creationError)
          }`,
        }, 500);
      }
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }, 500);
    }
  },
);

export { workspacesRoutes };
