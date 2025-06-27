/**
 * Zod schemas for API response validation
 */

import { z } from "zod/v4";

// Daemon schemas
export const DaemonStatusSchema = z.object({
  status: z.string(),
  activeWorkspaces: z.number(),
  uptime: z.number(),
  workspaces: z.array(z.string()),
});

// Workspace schemas
export const WorkspaceInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  status: z.string(),
  path: z.string(),
  hasActiveRuntime: z.boolean(),
  createdAt: z.string(),
  lastSeen: z.string(),
});

export const WorkspaceRuntimeSchema = z.object({
  status: z.string(),
  startedAt: z.string(),
  sessions: z.number(),
  workers: z.number(),
});

export const WorkspaceDetailedInfoSchema = WorkspaceInfoSchema.extend({
  runtime: WorkspaceRuntimeSchema.optional(),
});

export const WorkspaceCreateResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
});

// Session schemas
export const SessionInfoSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  status: z.string(),
  summary: z.string(),
  signal: z.string(),
  startTime: z.string(),
  endTime: z.string().optional(),
  progress: z.number(),
});

export const SessionDetailedInfoSchema = SessionInfoSchema.extend({
  artifacts: z.array(z.object({
    type: z.string(),
    data: z.unknown(),
  })),
  results: z.unknown().optional(),
});

export const WorkspaceSessionInfoSchema = z.object({
  id: z.string(),
  status: z.string(),
  startedAt: z.string(),
});

export const CancelSessionResponseSchema = z.object({
  message: z.string(),
  workspaceId: z.string(),
});

export const LogEntrySchema = z.object({
  timestamp: z.string(),
  level: z.string(),
  message: z.string(),
  component: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const SessionLogsResponseSchema = z.object({
  logs: z.array(LogEntrySchema),
});

// Library schemas
export const LibraryItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  description: z.string().optional(),
  metadata: z.object({
    format: z.string(),
    source: z.string(),
    session_id: z.string().optional(),
    agent_ids: z.array(z.string()).optional(),
    custom_fields: z.record(z.string(), z.unknown()).optional(),
  }),
  created_at: z.string(),
  updated_at: z.string(),
  tags: z.array(z.string()),
  size_bytes: z.number(),
  workspace_id: z.string().optional(),
});

export const LibrarySearchResultSchema = z.object({
  items: z.array(LibraryItemSchema),
  total: z.number(),
  query: z.record(z.string(), z.unknown()),
  took_ms: z.number(),
});

export const LibraryStatsSchema = z.object({
  total_items: z.number(),
  total_size_bytes: z.number(),
  types: z.record(z.string(), z.number()),
  recent_activity: z.array(z.object({
    date: z.string(),
    items_added: z.number(),
    items_modified: z.number(),
  })),
});

export const TemplateConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  format: z.string(),
  engine: z.string(),
  config: z.record(z.string(), z.unknown()),
  schema: z.record(z.string(), z.unknown()).optional(),
});

export const LibraryItemWithContentSchema = z.object({
  item: LibraryItemSchema,
  content: z.union([z.string(), z.instanceof(Uint8Array)]).optional(),
});

// Signal schemas
export const SignalInfoSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});

export const SignalTriggerResponseSchema = z.object({
  message: z.string(),
  status: z.string(),
  workspaceId: z.string(),
  signalId: z.string(),
});

// Agent schemas
export const AgentInfoSchema = z.object({
  id: z.string(),
  type: z.string(),
  purpose: z.string().optional(),
});

export const JobInfoSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});

// Generic response schemas
export const MessageResponseSchema = z.object({
  message: z.string(),
});

export const DeleteResponseSchema = z.object({
  message: z.string(),
});
