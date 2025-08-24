import { z } from "zod/v4";

// Single source of truth for workspace types
export const WorkspaceStatusSchema = z.enum(["inactive", "running", "stopped"]);

export const WorkspaceMetadataSchema = z.object({
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  system: z.boolean().optional(),
  atlasVersion: z.string().optional(),
  // Error tracking fields
  lastError: z.string().optional(),
  lastErrorAt: z.string().datetime().optional(),
  failureCount: z.number().optional(),
  // Session tracking fields
  lastFinishedSession: z
    .object({
      id: z.string(),
      status: z.enum(["completed", "failed"]),
      finishedAt: z.string().datetime(),
      summary: z.string().optional(),
    })
    .optional(),
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
  INACTIVE: "inactive",
  RUNNING: "running",
  STOPPED: "stopped",
} as const;
