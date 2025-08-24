/**
 * Daemon status constants
 */
export const DAEMON_STATUS = {
  HEALTHY: "healthy",
  UNHEALTHY: "unhealthy",
  ERROR: "error",
  IDLE: "idle",
} as const;

export type DaemonStatus = (typeof DAEMON_STATUS)[keyof typeof DAEMON_STATUS];
