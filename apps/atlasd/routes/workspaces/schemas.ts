import { z } from "zod";

// ============================================================================
// Base Schemas
// ============================================================================

// ============================================================================
// Input Schemas
// ============================================================================

export const addWorkspaceSchema = z.object({
  path: z.string().min(1, "Path is required"),
  name: z.string().optional(),
  description: z.string().optional(),
});

export const addWorkspaceBatchSchema = z.object({
  paths: z.array(z.string()).min(1, "Paths array must not be empty"),
});

export const updateWorkspaceConfigSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  backup: z.boolean().optional(),
});

export const createWorkspaceFromConfigSchema = z
  .object({
    config: z.record(z.string(), z.unknown()).describe("Generated workspace configuration"),
    workspaceName: z
      .string()
      .optional()
      .describe("Custom workspace directory name (auto-resolves conflicts with -2, -3, etc.)"),
    ephemeral: z.boolean().optional().default(false).describe("Create as ephemeral workspace"),
  })
  .meta({ description: "Create workspace from configuration" });
