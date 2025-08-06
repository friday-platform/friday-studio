import { z } from "zod/v4";

// ============================================================================
// Shared Parameter Schemas
// ============================================================================

export const workspaceIdParamSchema = z.object({
  workspaceId: z.string().meta({ description: "Workspace identifier" }),
});

// ============================================================================
// Status and Base Schemas
// ============================================================================

export const workspaceStatusSchema = z.enum([
  "stopped",
  "starting",
  "running",
  "stopping",
  "crashed",
  "unknown",
]).meta({
  description: "Current status of the workspace",
});

export const workspaceRuntimeSchema = z.object({
  status: z.string().meta({ description: "Runtime status" }),
  startedAt: z.string().meta({ description: "ISO 8601 timestamp when runtime started" }),
  sessions: z.number().meta({ description: "Number of active sessions" }),
  workers: z.number().meta({ description: "Number of active workers" }),
}).meta({
  description: "Runtime information for an active workspace",
});

// ============================================================================
// Response Schemas
// ============================================================================

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

// ============================================================================
// Input Schemas
// ============================================================================

export const createWorkspaceFromConfigSchema = z.object({
  config: z.record(z.string(), z.unknown()).describe("Generated workspace configuration"),
  workspaceName: z.string().optional().describe(
    "Custom workspace directory name (auto-resolves conflicts with -2, -3, etc.)",
  ),
}).meta({ description: "Create workspace from configuration" });

export const createWorkspaceFromConfigResponseSchema = z.object({
  success: z.boolean(),
  workspace: workspaceResponseSchema.optional(),
  workspacePath: z.string().optional(),
  filesCreated: z.array(z.string()).optional(),
  error: z.string().optional(),
}).meta({ description: "Create workspace from configuration response" });

export const updateWorkspaceSchema = z.object({
  config: z.record(z.string(), z.unknown()).describe("Updated workspace configuration"),
  backup: z.boolean().optional().default(true).describe("Create backup before updating"),
}).meta({ description: "Update workspace configuration" });

export const updateWorkspaceResponseSchema = z.object({
  success: z.boolean(),
  workspace: workspaceResponseSchema.optional(),
  backupPath: z.string().optional(),
  filesModified: z.array(z.string()).optional(),
  reloadRequired: z.boolean().optional(),
  runtimeReloaded: z.boolean().optional(),
  runtimeDestroyed: z.boolean().optional(),
  message: z.string().optional(),
  error: z.string().optional(),
}).meta({ description: "Update workspace configuration response" });

// ============================================================================
// Error Schemas
// ============================================================================

export const errorResponseSchema = z.object({
  error: z.string().meta({ description: "Error message" }),
  code: z.string().optional().meta({ description: "Error code" }),
  details: z.unknown().optional().meta({ description: "Additional error details" }),
}).meta({
  id: "ErrorResponse",
  description: "Standard error response",
});

// ============================================================================
// Type Exports
// ============================================================================

export type WorkspaceResponse = z.infer<typeof workspaceResponseSchema>;
export type WorkspaceDetailsResponse = z.infer<typeof workspaceDetailsResponseSchema>;
export type CreateWorkspaceFromConfigRequest = z.infer<typeof createWorkspaceFromConfigSchema>;
export type CreateWorkspaceFromConfigResponse = z.infer<
  typeof createWorkspaceFromConfigResponseSchema
>;
export type UpdateWorkspaceRequest = z.infer<typeof updateWorkspaceSchema>;
export type UpdateWorkspaceResponse = z.infer<typeof updateWorkspaceResponseSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
