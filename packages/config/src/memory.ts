/**
 * Memory configuration schemas
 */

import { z } from "zod";
import { DurationSchema, MemoryScope } from "./base.ts";

// ==============================================================================
// WORKSPACE MEMORY (Simple configuration for workspace.yml)
// ==============================================================================

export const WorkspaceMemoryConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  scope: MemoryScope.optional().describe("Memory scope level"),

  retention: z
    .strictObject({
      max_age_days: z.number().int().positive(),
      max_entries: z.number().int().positive(),
      cleanup_interval_hours: z.number().int().positive().optional(),
    })
    .optional(),

  session: z
    .strictObject({
      include_in_context: z.boolean().optional(),
      max_context_entries: z.number().int().positive().optional(),
    })
    .optional(),

  include_types: z.array(z.string()).optional().describe("Types of memory to track"),

  // Session Bridge Memory Configuration
  sessionBridge: z
    .strictObject({
      enabled: z.boolean(),
      maxTurns: z.number().int().positive().default(10),
      retentionHours: z.number().positive().default(48),
      tokenAllocation: z.number().min(0).max(1).default(0.1),
      relevanceThreshold: z.number().min(0).max(1).default(0.6),
    })
    .optional()
    .describe("Session bridge memory for cross-session continuity"),

  // Worklog Configuration
  worklog: z
    .strictObject({
      enabled: z.boolean(),
      autoDetect: z.boolean().default(true),
      confidenceThreshold: z.number().min(0).max(1).default(0.7),
      maxEntriesPerSession: z.number().int().positive().default(20),
      retentionDays: z.number().int().positive().default(90),
    })
    .optional()
    .describe("Automated worklog for institutional memory"),
});
export type WorkspaceMemoryConfig = z.infer<typeof WorkspaceMemoryConfigSchema>;

// ==============================================================================
// ATLAS MEMORY (Complex configuration for atlas.yml)
// ==============================================================================

/**
 * Memory type configuration
 */
const MemoryTypeConfigSchema = z.strictObject({
  enabled: z.boolean(),
  max_age_hours: z.number().positive().optional(),
  max_age_days: z.number().positive().optional(),
  max_entries: z.number().int().min(0).optional(),
});

/**
 * Memory scope configuration (reused for agent/session/workspace)
 */
const MemoryScopeConfigSchema = z.strictObject({
  enabled: z.boolean(),
  scope: MemoryScope,
  include_in_context: z.boolean(),

  context_limits: z.strictObject({
    relevant_memories: z.number().int().min(0),
    past_successes: z.number().int().min(0),
    past_failures: z.number().int().min(0),
  }),

  memory_types: z
    .strictObject({
      working: MemoryTypeConfigSchema.optional(),
      procedural: MemoryTypeConfigSchema.optional(),
      episodic: MemoryTypeConfigSchema.optional(),
      semantic: MemoryTypeConfigSchema.optional(),
      contextual: MemoryTypeConfigSchema.optional(),
    })
    .describe("Different types of memory with individual configurations"),
});

/**
 * Atlas memory configuration (complex, platform-level)
 */
export const AtlasMemoryConfigSchema = z.strictObject({
  // Default memory settings
  default: z.strictObject({
    enabled: z.boolean(),
    storage: z.string().describe("Memory storage backend"),
    cognitive_loop: z.boolean().describe("Enable cognitive processing"),
    retention: z.strictObject({
      max_age_days: z.number().int().positive(),
      max_entries: z.number().int().positive().optional(),
      cleanup_interval_hours: z.number().int().positive(),
    }),
  }),

  // Streaming configuration for performance
  streaming: z
    .strictObject({
      enabled: z.boolean(),
      queue_max_size: z.number().int().positive(),
      batch_size: z.number().int().positive(),
      flush_interval: DurationSchema,
      background_processing: z.boolean(),
      persistence_enabled: z.boolean(),
      error_retry_attempts: z.number().int().min(0),
      priority_processing: z.boolean(),
      dual_write_enabled: z.boolean().describe("Safe migration mode"),
      legacy_batch_enabled: z.boolean().describe("Legacy batch processing"),
      stream_everything: z.boolean().describe("Stream all memory operations"),
      performance_tracking: z.boolean().describe("Track performance metrics"),
    })
    .optional(),

  // Scoped memory configurations
  agent: MemoryScopeConfigSchema,
  session: MemoryScopeConfigSchema,
  workspace: MemoryScopeConfigSchema,
});
export type AtlasMemoryConfig = z.infer<typeof AtlasMemoryConfigSchema>;
