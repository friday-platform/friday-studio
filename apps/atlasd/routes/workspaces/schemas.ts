import { z } from "zod";

// ============================================================================
// Base Schemas
// ============================================================================

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
    ephemeral: z.boolean().optional().default(false).describe("Create as ephemeral workspace"),
  })
  .meta({ description: "Create workspace from configuration" });
