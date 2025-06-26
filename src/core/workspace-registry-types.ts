import { z } from "zod/v4";

// Zod schemas for validation
export const WorkspaceStatusSchema = z.enum([
  "stopped",
  "starting",
  "running",
  "stopping",
  "crashed",
  "unknown",
]);

export const WorkspaceMetadataSchema = z.object({
  atlasVersion: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  environment: z.string().optional(),
}).optional();

export const WorkspaceEntrySchema = z.object({
  // Identification
  id: z.string(), // Docker-style name (e.g., "fervent_einstein")
  name: z.string(), // Human-readable name

  // Location
  path: z.string(),
  configPath: z.string(),

  // Cached Configuration (loaded once at registration time)
  config: z.record(z.string(), z.any()).optional(), // Full workspace config
  configHash: z.string().optional(), // SHA-256 hash for change detection

  // Runtime state
  status: WorkspaceStatusSchema,
  pid: z.number().optional(),
  port: z.number().optional(),

  // Timestamps
  createdAt: z.string().datetime(),
  lastSeen: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  stoppedAt: z.string().datetime().optional(),

  // Metadata
  metadata: WorkspaceMetadataSchema,
});

export const WorkspaceRegistrySchema = z.object({
  version: z.string(),
  workspaces: z.array(WorkspaceEntrySchema),
  lastUpdated: z.string().datetime(),
});

// Type inference from schemas
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;
export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>;
export type WorkspaceRegistry = z.infer<typeof WorkspaceRegistrySchema>;

// Export enum for convenience
export const WorkspaceStatus = {
  STOPPED: "stopped" as const,
  STARTING: "starting" as const,
  RUNNING: "running" as const,
  STOPPING: "stopping" as const,
  CRASHED: "crashed" as const,
  UNKNOWN: "unknown" as const,
};
