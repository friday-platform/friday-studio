/**
 * Daemon-related type definitions
 */

export interface DaemonStatus {
  status: string;
  activeWorkspaces: number;
  uptime: number;
  memoryUsage: { rss: number; heapTotal: number; heapUsed: number; external: number };
  workspaces: string[];
  configuration: { maxConcurrentWorkspaces: number; idleTimeoutMs: number };
}
