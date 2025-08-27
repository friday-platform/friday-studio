/**
 * Zod schemas for API response validation
 */

import { z } from "zod/v4";

// Daemon schemas
export const DaemonStatusSchema = z.object({
  status: z.string(),
  activeWorkspaces: z.number(),
  uptime: z.number(),
  memoryUsage: z.object({
    rss: z.number(),
    heapTotal: z.number(),
    heapUsed: z.number(),
    external: z.number(),
  }),
  workspaces: z.array(z.string()),
  configuration: z.object({ maxConcurrentWorkspaces: z.number(), idleTimeoutMs: z.number() }),
});

// Workspace schemas
export const WorkspaceInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  status: z.string(),
  path: z.string(),
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

export const WorkspaceCreateResponseSchema = z.object({ id: z.string(), name: z.string() });

export const WorkspaceAddRequestSchema = z.object({
  path: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
});

export const WorkspaceBatchAddRequestSchema = z.object({ paths: z.array(z.string()) });

export const WorkspaceBatchAddResponseSchema = z.object({
  added: z.array(WorkspaceInfoSchema),
  failed: z.array(z.object({ path: z.string(), error: z.string() })),
});

// Session schemas
export const SessionInfoSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  status: z.string(),
  summary: z.string(),
  signal: z.string(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  progress: z.number(),
});

export const SessionDetailedInfoSchema = SessionInfoSchema.extend({
  artifacts: z.array(z.object({ type: z.string(), data: z.unknown() })),
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

export const SessionLogsResponseSchema = z.object({ logs: z.array(LogEntrySchema) });

// Library schemas
export const LibraryItemSchema = z.object({
  id: z.string(),
  source: z.enum(["agent", "job", "user", "system"]),
  name: z.string(),
  description: z.string().optional(),
  content_path: z.string(),
  full_path: z.string(),
  file_extension: z.string(),
  mime_type: z.string(),
  session_id: z.string().optional(),
  agent_ids: z.array(z.string()).optional(),
  template_id: z.string().optional(),
  generated_by: z.string().optional(),
  custom_fields: z.record(z.string(), z.unknown()).optional(),
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
  sources: z.record(z.string(), z.number()),
  tags: z.record(z.string(), z.number()).optional(),
  recent_activity: z.array(
    z.object({ date: z.string(), items_added: z.number(), items_modified: z.number() }),
  ),
});

export const TemplateConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  format: z.string(),
  engine: z.string(),
  category: z.string().optional(),
  config: z.record(z.string(), z.unknown()),
  schema: z.record(z.string(), z.unknown()).optional(),
});

export const LibraryItemWithContentSchema = z.object({
  item: LibraryItemSchema,
  content: z.union([z.string(), z.instanceof(Uint8Array)]).optional(),
});

// Signal schemas
export const SignalInfoSchema = z.object({ description: z.string().optional() });

export const SignalDetailedInfoSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  provider: z.string(),
  method: z.string().optional(),
  path: z.string().optional(),
  endpoint: z.string().optional(),
  headers: z.record(z.string(), z.unknown()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  schema: z
    .object({
      type: z.string(),
      properties: z.record(z.string(), z.unknown()).optional(),
      required: z.array(z.string()).optional(),
    })
    .optional(),
  webhook_secret: z.string().optional(),
  timeout_ms: z.number().optional(),
  retry_config: z
    .object({ max_retries: z.number().optional(), retry_delay_ms: z.number().optional() })
    .optional(),
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

export const JobInfoSchema = z.object({ name: z.string(), description: z.string().optional() });

export const JobDetailedInfoSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  task_template: z.string().optional(),
  triggers: z.array(z.object({ signal: z.string(), condition: z.string().optional() })).optional(),
  session_prompts: z
    .object({ planning: z.string().optional(), evaluation: z.string().optional() })
    .optional(),
  execution: z.object({
    strategy: z.enum(["sequential", "parallel"]),
    agents: z.array(
      z.union([
        z.string(),
        z.object({
          id: z.string(),
          task: z.string().optional(),
          input_source: z.enum(["signal", "previous", "combined", "filesystem_context"]).optional(),
          dependencies: z.array(z.string()).optional(),
          tools: z.array(z.string()).optional(),
        }),
      ]),
    ),
    context: z
      .object({
        filesystem: z
          .object({
            patterns: z.array(z.string()),
            base_path: z.string().optional(),
            max_file_size: z.number().optional(),
            include_content: z.boolean().optional(),
          })
          .optional(),
        memory: z
          .object({ recall_limit: z.number().optional(), strategy: z.string().optional() })
          .optional(),
      })
      .optional(),
    timeout_seconds: z.number().optional(),
    max_iterations: z.number().optional(),
  }),
  success_criteria: z.record(z.string(), z.unknown()).optional(),
  error_handling: z
    .object({
      max_retries: z.number().optional(),
      retry_delay_seconds: z.number().optional(),
      timeout_seconds: z.number().optional(),
      stage_failure_strategy: z.string().optional(),
    })
    .optional(),
  resources: z
    .object({
      estimated_duration_seconds: z.number().optional(),
      max_memory_mb: z.number().optional(),
      required_capabilities: z.array(z.string()).optional(),
      concurrent_agent_limit: z.number().optional(),
    })
    .optional(),
});

// Workspace template schemas
export const WorkspaceTemplateInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()).optional(),
});

export const WorkspaceTemplateListResponseSchema = z.array(WorkspaceTemplateInfoSchema);

export const CreateWorkspaceFromTemplateRequestSchema = z.object({
  templateId: z.string(),
  name: z.string(),
  path: z.string(),
});

export const CreateWorkspaceFromTemplateResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  templateId: z.string(),
  message: z.string(),
});

// Generic response schemas
export const MessageResponseSchema = z.object({ message: z.string() });

export const DeleteResponseSchema = z.object({ message: z.string() });
