import { z } from "zod/v4";

// Single source of truth for workspace types
export const WorkspaceStatusSchema = z.enum([
  "stopped",
  "starting",
  "running",
  "stopping",
  "crashed",
  "failed", // Workspace is running but unable to process signals due to errors (e.g., MCP init failure)
  "unknown",
]);

export const WorkspaceMetadataSchema = z.object({
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  system: z.boolean().optional(),
  atlasVersion: z.string().optional(),
  // Error tracking fields
  lastError: z.string().optional(),
  lastErrorAt: z.string().datetime().optional(),
  failureCount: z.number().optional(),
});

export const WorkspaceEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(), // For system workspaces: "system://atlas-conversation"
  configPath: z.string(),
  configHash: z.string().optional(),
  status: WorkspaceStatusSchema,
  createdAt: z.iso.datetime(),
  lastSeen: z.iso.datetime(),
  startedAt: z.iso.datetime().optional(),
  stoppedAt: z.iso.datetime().optional(),
  pid: z.number().optional(),
  port: z.number().optional(),
  metadata: WorkspaceMetadataSchema.optional(),
});

export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>;
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;
export type WorkspaceMetadata = z.infer<typeof WorkspaceMetadataSchema>;

// Export enum for convenience
export const WorkspaceStatusEnum = {
  STOPPED: "stopped",
  STARTING: "starting",
  RUNNING: "running",
  STOPPING: "stopping",
  CRASHED: "crashed",
  FAILED: "failed",
  UNKNOWN: "unknown",
} as const;
