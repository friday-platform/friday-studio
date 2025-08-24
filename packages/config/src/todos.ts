/**
 * Todo System Shared Types
 *
 * Shared schemas and types for the todo storage system
 * used by both the Atlas daemon and conversation agents.
 */

import { z } from "zod/v4";

// ============================================================================
// Data Schemas
// ============================================================================

export const TodoItemSchema = z.object({
  id: z.string().describe("Unique identifier for the todo item"),
  content: z.string().min(1).describe("Brief description of the task"),
  status: z
    .enum(["pending", "in_progress", "completed", "cancelled"])
    .describe("Current status of the task"),
  priority: z.enum(["high", "medium", "low"]).describe("Priority level of the task"),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Additional context (workspace names, IDs, etc.)"),
  createdAt: z.string().describe("ISO timestamp of creation"),
  updatedAt: z.string().describe("ISO timestamp of last update"),
});

// ============================================================================
// Type Exports
// ============================================================================

export type TodoItem = z.infer<typeof TodoItemSchema>;
