/**
 * Daemon-related type definitions
 */

export interface DaemonStatus {
  status: string;
  activeWorkspaces: number;
  uptime: number;
  workspaces: string[];
}
