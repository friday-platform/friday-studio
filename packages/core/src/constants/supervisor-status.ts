/**
 * Supervisor status constants shared across packages
 */

import { z } from "zod";

/**
 * Session Supervisor internal states
 */
export const SessionSupervisorStatus = {
  IDLE: "idle",
  PLANNING: "planning",
  EXECUTING: "executing",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

/**
 * Reasoning execution outcomes
 */
export const ReasoningResultStatus = {
  COMPLETED: "completed",
  FAILED: "failed",
  PARTIAL: "partial",
  CANCELLED: "cancelled",
} as const;

/**
 * Workspace session status — single source of truth.
 *
 * - active:      session is currently running
 * - completed:   finished successfully
 * - failed:      platform/system error
 * - skipped:     user configuration issue (e.g. OAuth not connected)
 * - cancelled:   session was cancelled by user
 * - interrupted: daemon was killed mid-session (set on startup recovery)
 */
export const WorkspaceSessionStatusSchema = z.enum([
  "active",
  "completed",
  "failed",
  "skipped",
  "cancelled",
  "interrupted",
]);

export type WorkspaceSessionStatusType = z.infer<typeof WorkspaceSessionStatusSchema>;

export const WorkspaceSessionStatus = {
  ACTIVE: "active",
  COMPLETED: "completed",
  FAILED: "failed",
  SKIPPED: "skipped",
  CANCELLED: "cancelled",
  INTERRUPTED: "interrupted",
} as const satisfies Record<string, WorkspaceSessionStatusType>;

// Type exports
export type SessionSupervisorStatusType =
  (typeof SessionSupervisorStatus)[keyof typeof SessionSupervisorStatus];
export type ReasoningResultStatusType =
  (typeof ReasoningResultStatus)[keyof typeof ReasoningResultStatus];
