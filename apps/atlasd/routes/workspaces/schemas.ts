import { WorkspaceConfigSchema } from "@atlas/config";
import { WorkspaceMetadataSchema, WorkspaceStatusSchema } from "@atlas/workspace";
import { z } from "zod/v4";

// ============================================================================
// Shared Parameter Schemas
// ============================================================================

export const workspaceIdParamSchema = z.object({
  workspaceId: z.string().meta({ description: "Workspace identifier" }),
});

// ============================================================================
// Base Schemas
// ============================================================================

const workspaceRuntimeSchema = z
  .object({
    status: z.string().meta({ description: "Runtime status" }),
    startedAt: z.string().meta({ description: "ISO 8601 timestamp when runtime started" }),
    sessions: z.number().meta({ description: "Number of active sessions" }),
    workers: z.number().meta({ description: "Number of active workers" }),
  })
  .meta({ description: "Runtime information for an active workspace" });

// ============================================================================
// Response Schemas
// ============================================================================

const workspaceResponseSchema = z
  .object({
    id: z.string().meta({ description: "Unique workspace identifier (Docker-style name)" }),
    name: z.string().meta({ description: "Human-readable workspace name" }),
    description: z.string().optional().meta({ description: "Workspace description" }),
    status: WorkspaceStatusSchema.meta({ description: "Current status of the workspace" }),
    path: z.string().meta({ description: "Filesystem path to the workspace" }),
    createdAt: z.string().meta({ description: "ISO 8601 timestamp when workspace was created" }),
    lastSeen: z.string().meta({ description: "ISO 8601 timestamp when workspace was last seen" }),
    metadata: WorkspaceMetadataSchema.optional().meta({
      description: "Workspace metadata including error tracking",
    }),
  })
  .meta({ description: "Workspace information" });

export const workspaceDetailsResponseSchema = z
  .object({
    id: z.string().meta({ description: "Unique workspace identifier (Docker-style name)" }),
    name: z.string().meta({ description: "Human-readable workspace name" }),
    description: z.string().optional().meta({ description: "Workspace description" }),
    status: WorkspaceStatusSchema.meta({ description: "Current status of the workspace" }),
    path: z.string().meta({ description: "Filesystem path to the workspace" }),
    createdAt: z.string().meta({ description: "ISO 8601 timestamp when workspace was created" }),
    lastSeen: z.string().meta({ description: "ISO 8601 timestamp when workspace was last seen" }),
    metadata: WorkspaceMetadataSchema.optional().meta({
      description: "Workspace metadata including error tracking",
    }),
    config: z.unknown().meta({ description: "Full workspace configuration" }),
    runtime: workspaceRuntimeSchema
      .optional()
      .meta({ description: "Runtime information if the workspace is active" }),
  })
  .meta({
    description: "Detailed workspace information including configuration and runtime status",
  });

export const workspaceConfigResponseSchema = z
  .object({ config: WorkspaceConfigSchema })
  .meta({ description: "Workspace configuration data for agent server consumption" });

// ============================================================================
// Input Schemas
// ============================================================================

export const createWorkspaceFromConfigSchema = z
  .object({
    config: z.record(z.string(), z.unknown()).describe("Generated workspace configuration"),
    workspaceName: z
      .string()
      .optional()
      .describe("Custom workspace directory name (auto-resolves conflicts with -2, -3, etc.)"),
  })
  .meta({ description: "Create workspace from configuration" });

export const createWorkspaceFromConfigResponseSchema = z
  .object({
    success: z.boolean(),
    workspace: workspaceResponseSchema.optional(),
    workspacePath: z.string().optional(),
    filesCreated: z.array(z.string()).optional(),
    error: z.string().optional(),
  })
  .meta({ description: "Create workspace from configuration response" });

export const updateWorkspaceSchema = z
  .object({
    config: z.record(z.string(), z.unknown()).describe("Updated workspace configuration"),
    backup: z.boolean().optional().default(true).describe("Create backup before updating"),
  })
  .meta({ description: "Update workspace configuration" });

export const updateWorkspaceResponseSchema = z
  .object({
    success: z.boolean(),
    workspace: workspaceResponseSchema.optional(),
    backupPath: z.string().optional(),
    filesModified: z.array(z.string()).optional(),
    reloadRequired: z.boolean().optional(),
    runtimeReloaded: z.boolean().optional(),
    runtimeDestroyed: z.boolean().optional(),
    message: z.string().optional(),
    error: z.string().optional(),
  })
  .meta({ description: "Update workspace configuration response" });

// ============================================================================
// Error Schemas
// ============================================================================

export const errorResponseSchema = z
  .object({
    error: z.string().meta({ description: "Error message" }),
    code: z.string().optional().meta({ description: "Error code" }),
    details: z.unknown().optional().meta({ description: "Additional error details" }),
  })
  .meta({ id: "ErrorResponse", description: "Standard error response" });

// ============================================================================
// Parameter Schemas
// ============================================================================

export const signalPathSchema = z.object({
  workspaceId: z.string().meta({ description: "Workspace identifier (ID or name)" }),
  signalId: z.string().meta({ description: "Signal name as defined in workspace configuration" }),
});

// ============================================================================
// Response Schemas
// ============================================================================

export const signalTriggerResponseSchema = z
  .object({
    message: z.string().meta({ description: "Status message" }),
    status: z.literal("processing").meta({ description: "Processing status" }),
    workspaceId: z.string().meta({ description: "Workspace identifier" }),
    signalId: z.string().meta({ description: "Signal identifier" }),
    sessionId: z.string().meta({ description: "Created session ID" }),
  })
  .meta({ description: "Signal trigger response" });
