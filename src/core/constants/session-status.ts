/**
 * Session status constants to avoid hardcoded strings
 */
export const SessionStatusEnum = {
  INITIALIZING: "initializing",
  STARTING: "starting",
  RUNNING: "running",
  ACTIVE: "active",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

export type SessionStatus = typeof SessionStatusEnum[keyof typeof SessionStatusEnum];
