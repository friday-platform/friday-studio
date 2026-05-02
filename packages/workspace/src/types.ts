import type { MergedConfig } from "@atlas/config";
import { WorkspaceSessionStatusSchema } from "@atlas/core";
import { ColorSchema } from "@atlas/utils";
import { z } from "zod";

// Single source of truth for workspace types
export const WorkspaceStatusSchema = z.enum(["inactive", "running", "stopped"]);

export const WorkspaceMetadataSchema = z.object({
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  system: z.boolean().optional(),
  canonical: z.enum(["personal", "system"]).optional(),
  atlasVersion: z.string().optional(),
  /** User ID who created this workspace, used for analytics */
  createdBy: z.string().optional(),
  color: ColorSchema.optional(),
  // Ephemeral workspace controls
  ephemeral: z.boolean().optional(),
  expiresAt: z.iso.datetime().optional(),
  // Setup tracking
  requires_setup: z.boolean().optional(),
  // Error tracking fields
  lastError: z.string().optional(),
  lastErrorAt: z.iso.datetime().optional(),
  failureCount: z.number().optional(),
  // Session tracking fields
  lastFinishedSession: z
    .object({
      id: z.string(),
      status: WorkspaceSessionStatusSchema,
      finishedAt: z.iso.datetime(),
      summary: z.string().optional(),
    })
    .optional(),
});

export const WorkspaceEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(), // For system workspaces: "system://<workspace-id>"
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

export interface WorkspaceSignalRegistrar {
  registerWorkspace: (
    workspaceId: string,
    workspacePath: string,
    config: MergedConfig,
  ) => Promise<void> | void;
  unregisterWorkspace: (workspaceId: string) => Promise<void> | void;
  shutdown?: () => Promise<void>;
}

/**
 * Callback interface for workspace wake-up
 */
export type WorkspaceSignalTriggerCallback<
  T extends Record<string, unknown> = Record<string, unknown>,
> = (workspaceId: string, signalId: string, signalData: T) => Promise<void> | void;

/**
 * Callback interface for workspace lifecycle events
 */
export interface WorkspaceLifecycleObserver {
  onWorkspaceRegistered?: (workspaceId: string, config: MergedConfig) => Promise<void> | void;
  onWorkspaceUnregistered?: (workspaceId: string) => Promise<void> | void;
  onWorkspaceConfigChanged?: (workspaceId: string, config: MergedConfig) => Promise<void> | void;
}
