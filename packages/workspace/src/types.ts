import { z } from "zod/v4";
import type { WorkspaceConfig } from "@atlas/config";

// Single source of truth for workspace types
export const WorkspaceStatusSchema = z.enum([
  "stopped",
  "starting",
  "running",
  "stopping",
  "crashed",
  "unknown",
]);

export const WorkspaceMetadataSchema = z.object({
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  system: z.boolean().optional(),
  atlasVersion: z.string().optional(),
});

export const WorkspaceEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(), // For system workspaces: "system://atlas-conversation"
  configPath: z.string(),
  configHash: z.string().optional(),
  status: WorkspaceStatusSchema,
  createdAt: z.string().datetime(),
  lastSeen: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  stoppedAt: z.string().datetime().optional(),
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
  UNKNOWN: "unknown",
} as const;

// Draft-related types
export interface WorkspaceDraft {
  id: string;
  name: string;
  description: string;
  config: Partial<WorkspaceConfig>;
  iterations: Array<{
    timestamp: string;
    operation: string;
    config: Record<string, unknown>;
    summary: string;
  }>;
  createdAt: string;
  updatedAt: string;
  status: "draft" | "published" | "abandoned";
  sessionId: string;
  conversationId?: string;
  userId: string;
}

export interface DraftLock {
  draftId: string;
  lockedBy: string;
  lockedAt: string;
  expiresAt: string;
  operation: string;
}

export interface LockResult {
  success: boolean;
  lock?: DraftLock;
  error?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
