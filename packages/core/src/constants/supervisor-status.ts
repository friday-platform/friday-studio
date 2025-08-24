/**
 * Supervisor status constants shared across packages
 */

/**
 * Session Supervisor internal states
 */
export const SessionSupervisorStatus = {
  IDLE: "idle",
  PLANNING: "planning",
  EXECUTING: "executing",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

/**
 * Reasoning execution outcomes
 */
export const ReasoningResultStatus = {
  COMPLETED: "completed",
  FAILED: "failed",
  PARTIAL: "partial",
} as const;

/**
 * Workspace session states
 */
export const WorkspaceSessionStatus = {
  PENDING: "pending",
  EXECUTING: "executing",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

// Type exports
export type SessionSupervisorStatusType =
  (typeof SessionSupervisorStatus)[keyof typeof SessionSupervisorStatus];
export type ReasoningResultStatusType =
  (typeof ReasoningResultStatus)[keyof typeof ReasoningResultStatus];
export type WorkspaceSessionStatusType =
  (typeof WorkspaceSessionStatus)[keyof typeof WorkspaceSessionStatus];
